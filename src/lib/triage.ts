import { dependencyIndex, shortRef } from "./deps";
import type { Column, PullRequest, Review, ThreadSummary, Triage, TriagedPull } from "./model";

const FAILING_CI = new Set(["FAILURE", "ERROR"]);

function isAfter(a: string | null, b: string | null): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return Date.parse(a) > Date.parse(b);
}

function latestThread(threads: ThreadSummary[]): ThreadSummary | null {
  return threads.reduce<ThreadSummary | null>(
    (best, t): ThreadSummary | null => (best === null || isAfter(t.lastAt, best.lastAt) ? t : best),
    null,
  );
}

function latestReview(reviews: Review[]): Review | null {
  return reviews.reduce<Review | null>(
    (best, r): Review | null => (best === null || isAfter(r.submittedAt, best.submittedAt) ? r : best),
    null,
  );
}

function result(column: Column, reason: string, actor: string | null, at: string | null): Triage {
  return { column, reason, actor, at };
}

function triageMine(pr: PullRequest, me: string, waitingOn: string[]): Triage {
  // Conflicts block everything else, so they lead, matching the PR's next step (nextStep.ts).
  if (pr.branch === "conflicts") return result("myTurn", "tem conflitos para resolver", null, pr.updatedAt);

  // Bot threads (CodeRabbit & co.) are noise: they never make it my turn.
  const open = pr.threads.filter(
    (t): boolean => !t.isResolved && !t.lastIsBot && t.lastAuthor !== null && t.lastAuthor !== me,
  );
  const thread = latestThread(open);
  if (thread !== null) {
    const more = open.length > 1 ? ` (+${open.length - 1})` : "";
    return result("myTurn", `comentou numa thread${more}`, thread.lastAuthor, thread.lastAt);
  }

  const changes = latestReview(pr.reviews.filter((r): boolean => r.state === "CHANGES_REQUESTED"));
  if (changes !== null && isAfter(changes.submittedAt, pr.lastCommitAt)) {
    return result("myTurn", "pediu mudanças", changes.author, changes.submittedAt);
  }

  if (pr.ciState !== null && FAILING_CI.has(pr.ciState)) {
    return result("myTurn", "CI falhando", null, pr.lastCommitAt);
  }

  const comment = pr.lastComment;
  if (comment !== null && comment.author !== me && isAfter(comment.at, pr.lastCommitAt)) {
    return result("myTurn", "comentou", comment.author, comment.at);
  }

  if (pr.reviewDecision === "APPROVED" && !pr.isDraft && waitingOn.length > 0) {
    return result("waiting", "aprovada, esperando dependência", null, pr.updatedAt);
  }

  if (pr.reviewDecision === "APPROVED" && !pr.isDraft) {
    const approval = latestReview(pr.reviews.filter((r): boolean => r.state === "APPROVED"));
    return result("myTurn", "aprovou, pronta para merge", approval?.author ?? null, approval?.submittedAt ?? null);
  }

  if (pr.isDraft) return result("waiting", "rascunho", null, pr.updatedAt);
  if (pr.reviews.length === 0) return result("waiting", "sem review ainda", null, pr.createdAt);
  const last = latestReview(pr.reviews);
  return result("waiting", "aguardando nova rodada de review", last?.author ?? null, last?.submittedAt ?? null);
}

function triageTheirs(pr: PullRequest, me: string): Triage {
  const replies = pr.threads.filter(
    (t): boolean =>
      !t.isResolved && !t.lastIsBot && t.firstAuthor === me && t.lastAuthor !== null && t.lastAuthor !== me,
  );
  const reply = latestThread(replies);
  if (reply !== null) {
    return result("myTurn", "respondeu sua thread", reply.lastAuthor, reply.lastAt);
  }

  if (pr.requestedReviewers.includes(me)) {
    return result("reviewRequested", "pediu seu review", pr.author, pr.updatedAt);
  }

  const mine = latestReview(pr.reviews.filter((r): boolean => r.author === me));
  if (mine !== null && isAfter(pr.lastCommitAt, mine.submittedAt)) {
    return result("reviewRequested", "fez commits depois do seu review", pr.author, pr.lastCommitAt);
  }

  if (pr.reviewDecision === "APPROVED") return result("others", "aprovada", pr.author, pr.updatedAt);
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return result("others", "com mudanças pedidas", pr.author, pr.updatedAt);
  return result("others", pr.isDraft ? "rascunho" : "aberta", pr.author, pr.updatedAt);
}

/** Decides whose turn a PR is, from `me`'s point of view. `waitingOn` lists open PRs that must merge first. */
export function triage(pr: PullRequest, me: string, waitingOn: string[] = []): Triage {
  return pr.author === me ? triageMine(pr, me, waitingOn) : triageTheirs(pr, me);
}

/** Groups PRs by column, most recent activity first in every column. */
export function board(prs: PullRequest[], me: string): Record<Column, TriagedPull[]> {
  const groups: Record<Column, TriagedPull[]> = { myTurn: [], reviewRequested: [], waiting: [], others: [] };
  const deps = dependencyIndex(prs);
  for (const pr of prs) {
    const open = deps.get(pr.id)?.blockedBy.filter((d): boolean => d.pr !== null) ?? [];
    const t = triage(pr, me, open.map(shortRef));
    groups[t.column].push({ pr, triage: t });
  }
  const recent = (p: TriagedPull): number => Date.parse(p.triage.at ?? p.pr.updatedAt);
  for (const items of Object.values(groups)) items.sort((a, b): number => recent(b) - recent(a));
  return groups;
}
