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
  if (pr.lastCommitAt !== null)
    marks.push({ kind: "commit", at: at(pr.lastCommitAt), label: `último commit há ${age(pr.lastCommitAt, now)}` });
  for (const r of pr.reviews) {
    const review = REVIEW_KIND[r.state];
    if (review === undefined || r.isBot === true) continue;
    marks.push({
      kind: review.kind,
      at: at(r.submittedAt),
      label: `${r.author} ${review.verb} há ${age(r.submittedAt, now)}`,
    });
  }
  for (const t of pr.threads) {
    if (t.isResolved || t.lastIsBot || t.lastAt === null) continue;
    marks.push({
      kind: "thread",
      at: at(t.lastAt),
      label: `${t.lastAuthor ?? "alguém"} numa conversa há ${age(t.lastAt, now)}`,
    });
  }
  if (pr.lastComment !== null)
    marks.push({
      kind: "comment",
      at: at(pr.lastComment.at),
      label: `${pr.lastComment.author} comentou há ${age(pr.lastComment.at, now)}`,
    });
  marks.sort((a, b): number => a.at - b.at);
  return { marks, idleFrom: marks.at(-1)?.at ?? 0 };
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
