import type { PrRef } from "./deps";

export type Column = "myTurn" | "reviewRequested" | "waiting" | "others";

export const COLUMNS: readonly Column[] = ["myTurn", "reviewRequested", "waiting", "others"];

export const COLUMN_LABEL: Record<Column, string> = {
  myTurn: "Sua vez",
  reviewRequested: "Review pedido",
  waiting: "Aguardando",
  others: "Outras",
};

/** What lands in each column; mirrors the rules in triage.ts. */
export const COLUMN_HINT: Record<Column, string> = {
  myTurn:
    "A bola está com você. Nas suas PRs: thread respondida, mudanças pedidas, CI falhando, comentário novo ou aprovada e pronta para merge. Nas dos outros: alguém respondeu uma thread que você abriu.",
  reviewRequested:
    "PRs de outras pessoas esperando você: pediram seu review, ou o autor fez commits depois do seu último review.",
  waiting: "Suas PRs esperando os outros: rascunho, sem review ainda ou aguardando nova rodada de review.",
  others: "PRs dos seus escopos (orgs e repos em Ajustes) em que você não tem nada pendente.",
};

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
export type CiState = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";

export interface Review {
  author: string;
  state: string;
  submittedAt: string;
}

/** Just enough of a review thread to decide whose turn it is. */
export interface ThreadSummary {
  isResolved: boolean;
  firstAuthor: string | null;
  lastAuthor: string | null;
  /** The last word came from a bot (CodeRabbit, Copilot, linters): noise, not a turn. */
  lastIsBot: boolean;
  lastAt: string | null;
}

export interface LastComment {
  author: string;
  at: string;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  repoUrl: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  author: string | null;
  headRef: string;
  baseRef: string;
  isCrossRepository: boolean;
  reviewDecision: ReviewDecision | null;
  ciState: CiState | null;
  lastCommitAt: string | null;
  requestedReviewers: string[];
  reviews: Review[];
  threads: ThreadSummary[];
  /** Latest human (non-bot) conversation comment. */
  lastComment: LastComment | null;
  /** Whether the branch can merge cleanly: "conflicts" needs fixing, "behind" means the base moved on. */
  branch: "ok" | "behind" | "conflicts";
  /** PRs the description says must merge first ("Depende de org/repo#12"). */
  dependsOn: PrRef[];
  /** Set only for PRs opened outside the board (from the feed) that are no longer open. */
  closed?: "MERGED" | "CLOSED";
}

/** Whose turn it is, plus the evidence that put the PR there. */
export interface Triage {
  column: Column;
  reason: string;
  actor: string | null;
  at: string | null;
}

export interface TriagedPull {
  pr: PullRequest;
  triage: Triage;
}

export interface Comment {
  id: string;
  author: string;
  avatarUrl: string;
  bodyHTML: string;
  createdAt: string;
  isBot: boolean;
}

export interface Thread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  /** Lines the thread covers on the PR head; absent when the thread is outdated. */
  range?: { start: number; end: number };
  /** The opening comment's ```suggestion replacement, while the thread is open. */
  suggestion: string | null;
  diffHunk: string;
  comments: Comment[];
}

export type CheckState = "success" | "failure" | "pending" | "neutral";

export interface Check {
  name: string;
  state: CheckState;
  url: string | null;
  /** GitHub Actions job id (CheckRun databaseId); null for commit statuses. */
  jobId: number | null;
  runId: number | null;
}

export interface PullDetail {
  bodyHTML: string;
  /** Markdown source of the description, for editing. */
  body: string;
  /** GitHub's mergeStateStatus: BEHIND means "Update branch" applies, DIRTY means conflicts. */
  mergeState: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  threads: Thread[];
  /** Conversation comments and review summaries with a body, oldest first. */
  timeline: (Comment & { reviewState: string | null })[];
  /** MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string;
  /** GitHub will merge it by itself once reviews and required checks pass. */
  autoMerge: boolean;
  /** The repo setting "Allow auto-merge"; off by default on GitHub. */
  autoMergeAllowed: boolean;
  /** The viewer's default merge method for this repo: MERGE, SQUASH or REBASE. */
  mergeMethod: string;
  /** The viewer's role on the repo: READ, TRIAGE, WRITE, MAINTAIN or ADMIN. */
  permission: string;
  labels: { name: string; color: string }[];
  /** Every label the repo defines, for picking. */
  repoLabels: string[];
  assignees: string[];
  /** Node ids of people who already reviewed, for re-requesting their review. */
  reviewerIds: string[];
  checks: Check[];
}

/** One changed file of a PR, with GitHub's own "viewed" mark. */
export interface PrFile {
  path: string;
  previousPath: string | null;
  /** added, removed, modified, renamed, … */
  status: string;
  additions: number;
  deletions: number;
  /** Null when GitHub omits the patch (binary or too large). */
  patch: string | null;
  viewed: boolean;
}

/** A line comment waiting to go out with the next review. */
export interface DraftComment {
  key: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  /** Proposed by the AI pass; the user still decides. */
  fromAi: boolean;
}

export interface AiReview {
  summary: string;
  risks: string[];
  lookFirst: { path: string; why: string }[];
}
