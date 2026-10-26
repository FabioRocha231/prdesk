import type { Config } from "./config";
import { parseDependencies } from "./deps";
import { githubGraphql, githubRest } from "./ipc";
import type {
  Check,
  CheckState,
  CiState,
  Comment,
  PrFile,
  PullDetail,
  PullRequest,
  ReviewDecision,
  Thread,
  ThreadSummary,
} from "./model";

const PR_FIELDS = `
  ... on PullRequest {
    id number title url body isDraft createdAt updatedAt headRefName baseRefName isCrossRepository reviewDecision
    mergeStateStatus
    repository { nameWithOwner url }
    author { login }
    commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
    latestReviews(first: 20) { nodes { author { login } state submittedAt } }
    reviewThreads(first: 30) {
      nodes {
        isResolved
        first: comments(first: 1) { nodes { author { login } } }
        last: comments(last: 1) { nodes { author { __typename login } createdAt } }
      }
    }
    comments(last: 5) { nodes { author { __typename login } createdAt } }
  }`;

const VIEWER_QUERY = "query { viewer { login } }";

const DETAIL_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      bodyHTML body mergeStateStatus additions deletions changedFiles mergeable
      repository { viewerDefaultMergeMethod }
      latestReviews(first: 20) { nodes { author { ... on User { id } } } }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 50) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name conclusion status databaseId detailsUrl
                    checkSuite { workflowRun { databaseId } }
                  }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 50) { nodes { id author { __typename login avatarUrl } bodyHTML createdAt diffHunk } }
        }
      }
      comments(first: 100) { nodes { id author { __typename login avatarUrl } bodyHTML createdAt } }
      reviews(first: 50) { nodes { id author { __typename login avatarUrl } state bodyHTML submittedAt } }
    }
  }
}`;

interface Login {
  login: string;
}

interface RawPull {
  id?: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  body: string;
  mergeable: string;
  mergeStateStatus: string;
  isCrossRepository: boolean;
  reviewDecision: ReviewDecision | null;
  repository: { nameWithOwner: string; url: string };
  author: Login | null;
  commits: { nodes: { commit: { committedDate: string; statusCheckRollup: { state: CiState } | null } }[] };
  reviewRequests: { nodes: { requestedReviewer: Partial<Login> | null }[] };
  latestReviews: { nodes: { author: Login | null; state: string; submittedAt: string }[] };
  reviewThreads: {
    nodes: {
      isResolved: boolean;
      first: { nodes: { author: Login | null }[] };
      last: { nodes: { author: (Login & { __typename: string }) | null; createdAt: string }[] };
    }[];
  };
  comments: { nodes: { author: (Login & { __typename: string }) | null; createdAt: string }[] };
}

interface Search {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: (RawPull | Record<string, never>)[];
}

function toThread(raw: RawPull["reviewThreads"]["nodes"][number]): ThreadSummary {
  const last = raw.last.nodes[0];
  return {
    isResolved: raw.isResolved,
    firstAuthor: raw.first.nodes[0]?.author?.login ?? null,
    lastAuthor: last?.author?.login ?? null,
    lastIsBot: last?.author?.__typename === "Bot",
    lastAt: last?.createdAt ?? null,
  };
}

/** GitHub computes these lazily; UNKNOWN reads as "ok" until the next poll. */
function branchState(mergeable: string, mergeState: string): PullRequest["branch"] {
  if (mergeable === "CONFLICTING" || mergeState === "DIRTY") return "conflicts";
  return mergeState === "BEHIND" ? "behind" : "ok";
}

function toPull(raw: RawPull & { id: string }): PullRequest {
  const commit = raw.commits.nodes[0]?.commit;
  const human = raw.comments.nodes.filter((c): boolean => c.author !== null && c.author.__typename !== "Bot").at(-1);
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    repo: raw.repository.nameWithOwner,
    repoUrl: raw.repository.url,
    isDraft: raw.isDraft,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    author: raw.author?.login ?? null,
    headRef: raw.headRefName,
    baseRef: raw.baseRefName,
    isCrossRepository: raw.isCrossRepository,
    branch: branchState(raw.mergeable, raw.mergeStateStatus),
    dependsOn: parseDependencies(raw.body, raw.repository.nameWithOwner),
    reviewDecision: raw.reviewDecision,
    ciState: commit?.statusCheckRollup?.state ?? null,
    lastCommitAt: commit?.committedDate ?? null,
    requestedReviewers: raw.reviewRequests.nodes.flatMap((r): string[] =>
      r.requestedReviewer?.login === undefined ? [] : [r.requestedReviewer.login],
    ),
    reviews: raw.latestReviews.nodes.flatMap((r) =>
      r.author === null ? [] : [{ author: r.author.login, state: r.state, submittedAt: r.submittedAt }],
    ),
    threads: raw.reviewThreads.nodes.map(toThread),
    lastComment: human?.author == null ? null : { author: human.author.login, at: human.createdAt },
  };
}

export function scopeQualifier(scope: string): string {
  return scope.includes("/") ? `repo:${scope}` : `org:${scope}`;
}

const BASE_FILTER = "is:pr is:open archived:false";

/**
 * Fields that change without bumping the PR's updatedAt (CI finishing, a conflict appearing), so every sync reads
 * them. mergeStateStatus is left out: it costs GitHub ~2–3s per 100 PRs; see MERGE_STATE_QUERY.
 */
const LIVE_FIELDS = `
  ... on PullRequest {
    id updatedAt isDraft reviewDecision mergeable
    commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  }`;

const LIVE_PAGE_SIZE = 100;
// ponytail: 3 pages × 100 per search; raise it or narrow the scopes when a scope outgrows 300 open PRs.
const MAX_LIVE_PAGES = 3;
// GitHub serializes heavy queries, so a few small batches in flight is as fast as it gets without 504s.
const DETAIL_BATCH = 20;
const DETAIL_CONCURRENCY = 3;

const LIVE_QUERY = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: ${LIVE_PAGE_SIZE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ${LIVE_FIELDS} }
  }
}`;

const DETAILS_SWEEP_EVERY_MS = 10 * 60 * 1000;
// Starts "just swept" so launching with a disk cache stays incremental; the first full sweep comes 10 minutes in.
let detailsSweptAt = Date.now();

// Behind-the-base is not urgent and costs a whole extra query (~3s); between checks the cached state stands.
const MERGE_STATE_EVERY_MS = 5 * 60 * 1000;
let mergeStateCheckedAt = 0;

/** "Behind its base" for the viewer's own PRs only: the one place that state drives an alert. */
const MERGE_STATE_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: ${LIVE_PAGE_SIZE}) { nodes { ... on PullRequest { id mergeStateStatus } } }
}`;

const DETAILS_QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { ${PR_FIELDS} } }`;

export type Live = Pick<RawPull, "updatedAt" | "isDraft" | "reviewDecision" | "mergeable" | "commits"> & {
  id: string;
};

/** Raw PRs by node id, as of the last sync; kept on disk so the board shows at once on the next launch. */
export type PullCache = Record<string, RawPull & { id: string }>;

/** PRs whose details must be fetched again: new ones and those GitHub says changed since the cached copy. */
export function staleIds(live: Live[], cache: PullCache): string[] {
  return live.filter((l): boolean => cache[l.id]?.updatedAt !== l.updatedAt).map((l): string => l.id);
}

/** Cached details with this sync's live fields on top; PRs that left every search drop out. */
export function mergeLive(
  live: Live[],
  cache: PullCache,
  fresh: PullCache,
  mergeStates: Map<string, string> = new Map(),
): PullCache {
  const next: PullCache = {};
  for (const l of live) {
    const base = fresh[l.id] ?? cache[l.id];
    const state = mergeStates.get(l.id);
    if (base !== undefined) next[l.id] = { ...base, ...l, ...(state === undefined ? {} : { mergeStateStatus: state }) };
  }
  return next;
}

export function pullsFromCache(cache: PullCache): PullRequest[] {
  return Object.values(cache).map(toPull);
}

/** Pages are sequential because each needs the previous cursor. */
async function searchLive(config: Config, q: string, into: Map<string, Live>): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LIVE_PAGES; page++) {
    const data: { search: { pageInfo: Search["pageInfo"]; nodes: (Live | Record<string, never>)[] } } =
      await githubGraphql(config.apiUrl, LIVE_QUERY, { q, cursor });
    for (const node of data.search.nodes) {
      // Search returns an empty object for non-PR hits.
      if ("id" in node && typeof node.id === "string") into.set(node.id, node as Live);
    }
    if (!data.search.pageInfo.hasNextPage) return;
    cursor = data.search.pageInfo.endCursor;
  }
}

/** Full details for `ids`, in batches with a bounded number in flight. */
async function fetchDetails(config: Config, ids: string[]): Promise<PullCache> {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += DETAIL_BATCH) batches.push(ids.slice(i, i + DETAIL_BATCH));
  const out: PullCache = {};
  const worker = async (): Promise<void> => {
    for (let batch = batches.shift(); batch !== undefined; batch = batches.shift()) {
      const data: { nodes: ((RawPull & { id: string }) | null)[] } = await githubGraphql(config.apiUrl, DETAILS_QUERY, {
        ids: batch,
      });
      // A node comes back null when it vanished or the token lost access in between; it simply drops out.
      for (const node of data.nodes) if (node !== null) out[node.id] = node;
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, batches.length) }, worker));
  return out;
}

/**
 * Every open PR in the configured scopes plus every open PR involving the viewer anywhere. Cheap live fields come
 * for all of them; full details only for PRs that changed since `cache`.
 */
export async function fetchPulls(
  config: Config,
  cache: PullCache,
  /** PRs whose details must be read again regardless of updatedAt (the user just acted on them). */
  force: ReadonlySet<string> = new Set(),
): Promise<{ me: string; pulls: PullRequest[]; cache: PullCache }> {
  const live = new Map<string, Live>();
  const queries = [`${BASE_FILTER} involves:@me`, `${BASE_FILTER} review-requested:@me`];
  if (config.scopes.length > 0) queries.push(`${BASE_FILTER} ${config.scopes.map(scopeQualifier).join(" ")}`);

  // GitHub queues one token's queries, so every extra request adds its full time; the merge-state one runs rarely.
  const checkMergeState = Date.now() - mergeStateCheckedAt >= MERGE_STATE_EVERY_MS;
  const [viewer, mine] = await Promise.all([
    githubGraphql<{ viewer: Login }>(config.apiUrl, VIEWER_QUERY, {}),
    checkMergeState
      ? githubGraphql<{ search: { nodes: ({ id: string; mergeStateStatus: string } | Record<string, never>)[] } }>(
          config.apiUrl,
          MERGE_STATE_QUERY,
          { q: `${BASE_FILTER} author:@me` },
        )
      : null,
    ...queries.map(async (q): Promise<void> => await searchLive(config, q, live)),
  ]);
  if (mine !== null) mergeStateCheckedAt = Date.now();
  const mergeStates = new Map(
    (mine?.search.nodes ?? []).flatMap((n): [string, string][] =>
      "id" in n && typeof n.id === "string" ? [[n.id, n.mergeStateStatus]] : [],
    ),
  );
  const all = [...live.values()];
  // Some changes (a thread resolved on github.com) do not bump updatedAt, so every so often all details are re-read.
  const sweep = Date.now() - detailsSweptAt >= DETAILS_SWEEP_EVERY_MS;
  const stale = sweep ? all.map((l): string => l.id) : [...new Set([...staleIds(all, cache), ...force])];
  const fresh = await fetchDetails(
    config,
    stale.filter((id): boolean => live.has(id)),
  );
  if (sweep) detailsSweptAt = Date.now();
  const next = mergeLive(all, cache, fresh, mergeStates);
  return { me: viewer.viewer.login, pulls: pullsFromCache(next), cache: next };
}

const PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { state mergeable ${PR_FIELDS} } }
}`;

/** One PR by repo and number, open or not: for feed items that are not on the board. */
export async function fetchPull(config: Config, repo: string, number: number): Promise<PullRequest> {
  const [owner = "", name = ""] = repo.split("/");
  const data: { repository: { pullRequest: (RawPull & { id: string; state: string }) | null } | null } =
    await githubGraphql(config.apiUrl, PULL_QUERY, { owner, name, number });
  const raw = data.repository?.pullRequest;
  if (raw == null) throw new Error(`PR ${repo}#${number} não encontrada.`);
  const pull = toPull(raw);
  return raw.state === "MERGED" || raw.state === "CLOSED" ? { ...pull, closed: raw.state } : pull;
}

interface RawComment {
  id: string;
  author: (Login & { avatarUrl: string; __typename: string }) | null;
  bodyHTML: string;
  createdAt: string;
}

interface RawDetail {
  node: {
    bodyHTML: string;
    body: string;
    mergeStateStatus: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    reviewThreads: {
      nodes: {
        id: string;
        isResolved: boolean;
        isOutdated: boolean;
        path: string;
        line: number | null;
        originalLine: number | null;
        comments: { nodes: (RawComment & { diffHunk: string })[] };
      }[];
    };
    comments: { nodes: RawComment[] };
    reviews: { nodes: (Omit<RawComment, "createdAt"> & { state: string; submittedAt: string })[] };
    mergeable: string;
    repository: { viewerDefaultMergeMethod: string };
    latestReviews: { nodes: { author: { id?: string } | null }[] };
    commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[] };
  } | null;
}

type RawContext =
  | {
      __typename: "CheckRun";
      name: string;
      conclusion: string | null;
      status: string;
      databaseId: number | null;
      detailsUrl: string | null;
      checkSuite: { workflowRun: { databaseId: number } | null } | null;
    }
  | { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null };

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PASSED = new Set(["SUCCESS"]);

function toCheck(raw: RawContext): Check {
  if (raw.__typename === "StatusContext") {
    const state = FAILED.has(raw.state) ? "failure" : PASSED.has(raw.state) ? "success" : "pending";
    return { name: raw.context, state, url: raw.targetUrl, jobId: null, runId: null };
  }
  const conclusion = raw.conclusion;
  let state: CheckState = "neutral";
  if (conclusion === null) state = "pending";
  else if (FAILED.has(conclusion)) state = "failure";
  else if (PASSED.has(conclusion)) state = "success";
  return {
    name: raw.name,
    state,
    url: raw.detailsUrl,
    jobId: raw.databaseId,
    runId: raw.checkSuite?.workflowRun?.databaseId ?? null,
  };
}

const GHOST = "ghost";

function toComment(raw: RawComment): Comment {
  return {
    id: raw.id,
    author: raw.author?.login ?? GHOST,
    avatarUrl: raw.author?.avatarUrl ?? "",
    bodyHTML: raw.bodyHTML,
    createdAt: raw.createdAt,
    isBot: raw.author?.__typename === "Bot",
  };
}

export async function fetchDetail(config: Config, id: string): Promise<PullDetail> {
  const { node } = await githubGraphql<RawDetail>(config.apiUrl, DETAIL_QUERY, { id });
  if (node === null) throw new Error("PR não encontrada.");

  const threads: Thread[] = node.reviewThreads.nodes.map(
    (t): Thread => ({
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line ?? t.originalLine,
      diffHunk: t.comments.nodes[0]?.diffHunk ?? "",
      comments: t.comments.nodes.map(toComment),
    }),
  );
  const reviews = node.reviews.nodes
    .filter((r): boolean => r.bodyHTML.trim() !== "")
    .map((r) => ({ ...toComment({ ...r, createdAt: r.submittedAt }), reviewState: r.state }));
  const comments = node.comments.nodes.map((c) => ({ ...toComment(c), reviewState: null }));
  const timeline = [...comments, ...reviews].sort((a, b): number => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  return {
    bodyHTML: node.bodyHTML,
    body: node.body,
    mergeState: node.mergeStateStatus,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    threads,
    timeline,
    mergeable: node.mergeable,
    mergeMethod: node.repository.viewerDefaultMergeMethod,
    reviewerIds: node.latestReviews.nodes.flatMap((r): string[] => (r.author?.id === undefined ? [] : [r.author.id])),
    checks: (node.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(toCheck),
  };
}

async function mutate(config: Config, mutation: string, variables: Record<string, unknown>): Promise<void> {
  await githubGraphql(config.apiUrl, mutation, variables);
}

export async function replyToThread(config: Config, threadId: string, body: string): Promise<void> {
  await mutate(
    config,
    `mutation($id: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { clientMutationId }
    }`,
    { id: threadId, body },
  );
}

export async function resolveThread(config: Config, threadId: string): Promise<void> {
  await mutate(config, "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }", {
    id: threadId,
  });
}

export async function addComment(config: Config, prId: string, body: string): Promise<void> {
  await mutate(
    config,
    "mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { clientMutationId } }",
    { id: prId, body },
  );
}

export async function approve(config: Config, prId: string): Promise<void> {
  await mutate(
    config,
    "mutation($id: ID!) { addPullRequestReview(input: { pullRequestId: $id, event: APPROVE }) { clientMutationId } }",
    { id: prId },
  );
}

export async function merge(config: Config, prId: string, method: string): Promise<void> {
  await mutate(
    config,
    `mutation($id: ID!, $method: PullRequestMergeMethod!) {
      mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId }
    }`,
    { id: prId, method },
  );
}

export async function markReady(config: Config, prId: string): Promise<void> {
  await mutate(
    config,
    "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }",
    { id: prId },
  );
}

export async function requestReviews(config: Config, prId: string, userIds: string[]): Promise<void> {
  await mutate(
    config,
    `mutation($id: ID!, $users: [ID!]) {
      requestReviews(input: { pullRequestId: $id, userIds: $users, union: true }) { clientMutationId }
    }`,
    { id: prId, users: userIds },
  );
}

export async function convertToDraft(config: Config, prId: string): Promise<void> {
  await mutate(
    config,
    "mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }",
    { id: prId },
  );
}

/** The REST address of a PR; only its repo and number matter. */
type PrRef = Pick<PullRequest, "id" | "repo" | "number">;

function repoPath(pr: PrRef): string {
  return `/repos/${pr.repo}/pulls/${pr.number}`;
}

const FILES_PAGE = 100;
// GitHub's REST files endpoint stops at 3000 files.
const MAX_FILE_PAGES = 30;

const VIEWED_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequest {
      files(first: ${FILES_PAGE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`;

interface RawFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

async function viewedPaths(config: Config, prId: string): Promise<Set<string>> {
  const viewed = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_FILE_PAGES; page++) {
    const data: {
      node: {
        files: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: { path: string; viewerViewedState: string }[];
        } | null;
      } | null;
    } = await githubGraphql(config.apiUrl, VIEWED_QUERY, { id: prId, cursor });
    const files = data.node?.files;
    if (files == null) break;
    for (const f of files.nodes) if (f.viewerViewedState === "VIEWED") viewed.add(f.path);
    if (!files.pageInfo.hasNextPage) break;
    cursor = files.pageInfo.endCursor;
  }
  return viewed;
}

/** Every changed file with its patch (REST) and the viewer's "viewed" mark (GraphQL), fetched in parallel. */
export async function fetchFiles(config: Config, pr: PrRef): Promise<PrFile[]> {
  const pages = async (): Promise<RawFile[]> => {
    const all: RawFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const batch = (await githubRest(
        config.apiUrl,
        "GET",
        `${repoPath(pr)}/files?per_page=${FILES_PAGE}&page=${page}`,
      )) as RawFile[];
      all.push(...batch);
      if (batch.length < FILES_PAGE) break;
    }
    return all;
  };
  const [raw, viewed] = await Promise.all([pages(), viewedPaths(config, pr.id)]);
  return raw.map(
    (f): PrFile => ({
      path: f.filename,
      previousPath: f.previous_filename ?? null,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
      viewed: viewed.has(f.filename),
    }),
  );
}

export async function setViewed(config: Config, prId: string, path: string, viewed: boolean): Promise<void> {
  const field = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
  await mutate(
    config,
    `mutation($id: ID!, $path: String!) { ${field}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`,
    { id: prId, path },
  );
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** One review with every pending line comment, like GitHub's "Finish your review". */
export async function submitReview(
  config: Config,
  pr: PullRequest,
  event: ReviewEvent,
  body: string,
  comments: { path: string; line: number; side: "LEFT" | "RIGHT"; body: string }[],
): Promise<void> {
  await githubRest(config.apiUrl, "POST", `${repoPath(pr)}/reviews`, { event, body, comments });
}

/** Merges the base into the PR branch on GitHub (the "Update branch" button). */
export async function updateBranch(config: Config, pr: PullRequest): Promise<void> {
  await githubRest(config.apiUrl, "PUT", `${repoPath(pr)}/update-branch`, {});
}

export async function editPull(
  config: Config,
  pr: PullRequest,
  patch: { title?: string; body?: string },
): Promise<void> {
  await githubRest(config.apiUrl, "PATCH", repoPath(pr), patch);
}

export async function requestReviewers(config: Config, pr: PullRequest, logins: string[]): Promise<void> {
  await githubRest(config.apiUrl, "POST", `${repoPath(pr)}/requested_reviewers`, { reviewers: logins });
}

/** Opens a PR from a pushed branch against the repo's default branch; returns its number. */
export async function createPull(
  config: Config,
  repo: string,
  head: string,
  title: string,
  body: string,
  draft: boolean,
): Promise<number> {
  const info = (await githubRest(config.apiUrl, "GET", `/repos/${repo}`)) as { default_branch: string };
  const created = (await githubRest(config.apiUrl, "POST", `/repos/${repo}/pulls`, {
    title,
    body,
    head,
    base: info.default_branch,
    draft,
  })) as { number: number };
  return created.number;
}

export interface DailyItem {
  repo: string;
  number: number;
  title: string;
  url: string;
}

export interface Daily {
  merged: DailyItem[];
  opened: DailyItem[];
  reviewed: DailyItem[];
}

const DAILY_FIELDS = "nodes { ... on PullRequest { number title url repository { nameWithOwner } } }";

/** What I shipped, opened and reviewed since `since` (a YYYY-MM-DD date), for the daily stand-up. */
export async function fetchDaily(config: Config, since: string): Promise<Daily> {
  const query = `query($merged: String!, $opened: String!, $reviewed: String!) {
    merged: search(query: $merged, type: ISSUE, first: 50) { ${DAILY_FIELDS} }
    opened: search(query: $opened, type: ISSUE, first: 50) { ${DAILY_FIELDS} }
    reviewed: search(query: $reviewed, type: ISSUE, first: 50) { ${DAILY_FIELDS} }
  }`;
  type Raw = {
    nodes: (
      | { number: number; title: string; url: string; repository: { nameWithOwner: string } }
      | Record<string, never>
    )[];
  };
  const data: Record<keyof Daily, Raw> = await githubGraphql(config.apiUrl, query, {
    merged: `is:pr author:@me merged:>=${since}`,
    opened: `is:pr author:@me created:>=${since}`,
    reviewed: `is:pr reviewed-by:@me -author:@me updated:>=${since}`,
  });
  const items = (raw: Raw): DailyItem[] =>
    raw.nodes.flatMap((n): DailyItem[] =>
      "number" in n ? [{ repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url }] : [],
    );
  return { merged: items(data.merged), opened: items(data.opened), reviewed: items(data.reviewed) };
}
