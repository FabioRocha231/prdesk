import type { LastComment, PullRequest, Review, ThreadSummary } from "./model";

/** GitHub logins are case-insensitive: "FabioRocha231" and "fabiorocha231" are the same person. */
export function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
  return a != null && b != null && a.toLowerCase() === b.toLowerCase();
}

export function isAfter(a: string | null, b: string | null): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return Date.parse(a) > Date.parse(b);
}

function latest<T>(items: T[], at: (item: T) => string | null): T | null {
  return items.reduce<T | null>(
    (best, item): T | null => (best === null || isAfter(at(item), at(best)) ? item : best),
    null,
  );
}

const FAILING_CI = new Set(["FAILURE", "ERROR"]);

/**
 * Everything the board, the next step and the reminders decide from, derived once per PR. Each question ("does my
 * approval still hold?", "was it re-requested?") is answered here and nowhere else, so the answers cannot drift.
 */
export interface PrFacts {
  pr: PullRequest;
  mine: boolean;
  conflicting: boolean;
  ciFailing: boolean;
  /**
   * Open human threads whose last word is someone else's, newest first: on my PR any of them, on theirs the ones I
   * wrote in.
   */
  threadsForMe: ThreadSummary[];
  /** The latest human request for changes that no push has answered yet. */
  changesPending: Review | null;
  /** A human conversation comment, by someone else, after my last push (my PR). */
  newComment: LastComment | null;
  /** GitHub's verdict is approved and it is not a draft. */
  approved: boolean;
  /** The latest human approval, for "who approved". */
  approval: Review | null;
  /** My own latest review (their PR). */
  myReview: Review | null;
  /** I approved and nothing was pushed since: approving again would only duplicate it. */
  myApprovalHolds: boolean;
  /** Commits landed after my approval or change request: they want another look. Comments alone do not count. */
  pushedSinceMyReview: boolean;
  /** Review asked of me, directly or through one of my teams. */
  requestedOfMe: boolean;
  /** Only through a team, not to me by name. */
  requestedViaTeam: boolean;
  /** People and teams asked to review and not answered since, without me. */
  pendingReviewers: string[];
  /** Reviewers who requested changes, saw a push after it, and were not asked to look again. */
  askAgain: string[];
  /** Open PRs that must merge first. */
  blockedBy: string[];
  /** Any human has reviewed it. */
  reviewed: boolean;
  /** When it became reviewable: last ready-for-review, else creation. */
  readyAt: string;
  /** When the latest of `who` was asked; null when nobody in it was. */
  askedAt: (who: string[]) => string | null;
}

export function prFacts(pr: PullRequest, me: string, blockedBy: string[] = []): PrFacts {
  const mine = sameLogin(pr.author, me);
  const humanReviews = pr.reviews.filter((r): boolean => r.isBot !== true);
  const pending = [...pr.requestedReviewers, ...(pr.requestedTeams ?? [])].filter((l): boolean => !sameLogin(l, me));

  const threadsForMe = pr.threads
    .filter(
      (t): boolean =>
        !t.isResolved &&
        !t.lastIsBot &&
        t.lastAuthor !== null &&
        !sameLogin(t.lastAuthor, me) &&
        (mine || [t.firstAuthor, ...(t.participants ?? [])].some((p): boolean => sameLogin(p, me))),
    )
    .sort((a, b): number => Date.parse(b.lastAt ?? "") - Date.parse(a.lastAt ?? ""));

  const changes = latest(
    humanReviews.filter((r): boolean => r.state === "CHANGES_REQUESTED"),
    (r): string => r.submittedAt,
  );
  const comment = pr.lastComment;
  const myReview = latest(
    humanReviews.filter((r): boolean => sameLogin(r.author, me)),
    (r): string => r.submittedAt,
  );
  const pushedSinceMyReview =
    myReview !== null && myReview.state !== "COMMENTED" && isAfter(pr.lastCommitAt, myReview.submittedAt);
  const askAgain = humanReviews
    .filter(
      (r): boolean =>
        r.state === "CHANGES_REQUESTED" &&
        isAfter(pr.lastCommitAt, r.submittedAt) &&
        !pr.requestedReviewers.some((l): boolean => sameLogin(l, r.author)),
    )
    .map((r): string => r.author);
  const requestedDirectly = pr.requestedReviewers.some((l): boolean => sameLogin(l, me));
  const requestedOfMe = requestedDirectly || pr.viewerRequested === true;
  const readyAt = pr.readyAt ?? pr.createdAt;

  return {
    pr,
    mine,
    conflicting: pr.branch === "conflicts",
    ciFailing: pr.ciState !== null && FAILING_CI.has(pr.ciState),
    threadsForMe,
    changesPending: changes !== null && isAfter(changes.submittedAt, pr.lastCommitAt) ? changes : null,
    newComment:
      comment !== null && !sameLogin(comment.author, me) && isAfter(comment.at, pr.lastCommitAt) ? comment : null,
    approved: pr.reviewDecision === "APPROVED" && !pr.isDraft,
    approval: latest(
      humanReviews.filter((r): boolean => r.state === "APPROVED"),
      (r): string => r.submittedAt,
    ),
    myReview,
    myApprovalHolds: myReview?.state === "APPROVED" && !pushedSinceMyReview,
    pushedSinceMyReview,
    requestedOfMe,
    requestedViaTeam: requestedOfMe && !requestedDirectly,
    pendingReviewers: pending,
    askAgain,
    blockedBy,
    reviewed: humanReviews.length > 0,
    readyAt,
    askedAt: (who): string | null =>
      latest(
        who.flatMap((w): string[] => {
          const at = Object.entries(pr.requestedAt ?? {}).find(([k]): boolean => sameLogin(k, w))?.[1];
          return at === undefined ? [] : [at];
        }),
        (at): string => at,
      ),
  };
}
