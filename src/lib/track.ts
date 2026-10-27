import { age } from "./format";
import type { PullRequest } from "./model";

export type MarkKind = "commit" | "approved" | "changes" | "commented" | "thread" | "comment";

export interface Mark {
  kind: MarkKind;
  /** 0 is when the PR was opened, 1 is now. */
  at: number;
  /** Tooltip: who did what, and how long ago. */
  label: string;
}

export interface Track {
  marks: Mark[];
  /** Where the last event sits: from there to now the PR has been idle. */
  idleFrom: number;
  /** When that last event happened (or the PR opened), in ms. */
  idleSince: number;
}

const REVIEW_KIND: Record<string, { kind: MarkKind; verb: string }> = {
  APPROVED: { kind: "approved", verb: "aprovou" },
  CHANGES_REQUESTED: { kind: "changes", verb: "pediu mudanças" },
  COMMENTED: { kind: "commented", verb: "comentou no review" },
};

/**
 * A PR's life on one line. Positions use the square root of the time left until now, so the last hours get more room
 * than the first days: on a PR open for a month, yesterday's review does not pile up against today's commit.
 */
export function prTrack(pr: PullRequest, now: number): Track {
  const opened = Date.parse(pr.createdAt);
  const span = Math.max(1, now - opened);
  const at = (iso: string): number => {
    const t = Math.min(now, Math.max(opened, Date.parse(iso)));
    return 1 - Math.sqrt((now - t) / span);
  };
  const marks: Mark[] = [];
  let last = opened;
  const seen = (iso: string): void => {
    last = Math.max(last, Math.min(now, Date.parse(iso)));
  };
  if (pr.lastCommitAt !== null) seen(pr.lastCommitAt);
  if (pr.lastCommitAt !== null)
    marks.push({ kind: "commit", at: at(pr.lastCommitAt), label: `último commit há ${age(pr.lastCommitAt, now)}` });
  for (const r of pr.reviews) {
    const review = REVIEW_KIND[r.state];
    if (review === undefined || r.isBot === true) continue;
    seen(r.submittedAt);
    marks.push({
      kind: review.kind,
      at: at(r.submittedAt),
      label: `${r.author} ${review.verb} há ${age(r.submittedAt, now)}`,
    });
  }
  for (const t of pr.threads) {
    if (t.isResolved || t.lastIsBot || t.lastAt === null) continue;
    seen(t.lastAt);
    marks.push({
      kind: "thread",
      at: at(t.lastAt),
      label: `${t.lastAuthor ?? "alguém"} numa conversa há ${age(t.lastAt, now)}`,
    });
  }
  if (pr.lastComment !== null) seen(pr.lastComment.at);
  if (pr.lastComment !== null)
    marks.push({
      kind: "comment",
      at: at(pr.lastComment.at),
      label: `${pr.lastComment.author} comentou há ${age(pr.lastComment.at, now)}`,
    });
  marks.sort((a, b): number => a.at - b.at);
  return { marks, idleFrom: marks.at(-1)?.at ?? 0, idleSince: last };
}

/** Marks closer than this (in track widths) draw as one, so a burst of activity stays readable. */
const CLUSTER_GAP = 0.035;
// The mark that speaks for a cluster: what most needs the reader's attention.
const WEIGHT: Record<MarkKind, number> = { changes: 5, approved: 4, thread: 3, commented: 2, comment: 1, commit: 0 };

export interface Cluster {
  kind: MarkKind;
  at: number;
  /** Every event in it, oldest first, for the tooltip. */
  labels: string[];
}

export function clusterMarks(marks: Mark[]): Cluster[] {
  const out: (Cluster & { last: number })[] = [];
  for (const m of marks) {
    const prev = out.at(-1);
    if (prev !== undefined && m.at - prev.last < CLUSTER_GAP) {
      prev.labels.push(m.label);
      prev.last = m.at;
      if (WEIGHT[m.kind] > WEIGHT[prev.kind]) prev.kind = m.kind;
    } else out.push({ kind: m.kind, at: m.at, labels: [m.label], last: m.at });
  }
  return out.map(({ last: _last, ...c }): Cluster => c);
}

/**
 * Past this many working hours without anything happening, a PR is in the slow tail that makes reviews painful
 * (Meta tracks the 75th percentile of time in review, about a day).
 */
export const STALE_HOURS = 24;
const DAY_MS = 86_400_000;

/** Hours between two instants, leaving Saturdays and Sundays (local time) out. */
export function workingHours(from: number, to: number): number {
  let ms = 0;
  let t = from;
  while (t < to) {
    const next = new Date(t);
    next.setHours(24, 0, 0, 0);
    const end = Math.min(to, next.getTime());
    const day = new Date(t).getDay();
    if (day !== 0 && day !== 6) ms += end - t;
    t = end;
    if (end - from > 400 * DAY_MS) break;
  }
  return ms / 3_600_000;
}

/** Where a PR sits in a stack of PRs built on each other's branches in one repo: "2/3"; null when alone. */
export function stackPosition(pr: PullRequest, pulls: PullRequest[]): { index: number; total: number } | null {
  const sameRepo = pulls.filter((p): boolean => p.repo === pr.repo && !p.isCrossRepository);
  const parent = (p: PullRequest): PullRequest | undefined =>
    sameRepo.find((q): boolean => q.id !== p.id && q.headRef === p.baseRef);
  const child = (p: PullRequest): PullRequest | undefined =>
    sameRepo.find((q): boolean => q.id !== p.id && q.baseRef === p.headRef);
  let root = pr;
  const seen = new Set([pr.id]);
  for (let up = parent(root); up !== undefined && !seen.has(up.id); up = parent(root)) {
    seen.add(up.id);
    root = up;
  }
  const chain: string[] = [];
  for (let p: PullRequest | undefined = root; p !== undefined && !chain.includes(p.id); p = child(p)) chain.push(p.id);
  const index = chain.indexOf(pr.id);
  return chain.length < 2 || index === -1 ? null : { index: index + 1, total: chain.length };
}

/** Small, medium or large by lines touched: how much reading the review asks for. */
export function sizeBand(size: { additions: number; deletions: number }): "P" | "M" | "G" {
  const lines = size.additions + size.deletions;
  return lines <= 50 ? "P" : lines <= 400 ? "M" : "G";
}

/** One person on the PR and where they stand; `asked` is a pending request with no answer since. */
export interface Crew {
  login: string;
  state: "approved" | "changes" | "commented" | "asked";
}

const CREW_STATE: Record<string, Crew["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
};

/** Reviewers with their latest word, then the ones asked who have not answered; bots stay out. */
export function prCrew(pr: PullRequest): Crew[] {
  const asked = new Set(pr.requestedReviewers);
  const crew: Crew[] = [];
  for (const r of pr.reviews) {
    const state = CREW_STATE[r.state];
    if (state === undefined || r.isBot === true || asked.has(r.author)) continue;
    crew.push({ login: r.author, state });
  }
  for (const login of asked) crew.push({ login, state: "asked" });
  return crew;
}
