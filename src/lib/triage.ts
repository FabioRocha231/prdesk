import { dependencyIndex, shortRef } from "./deps";
import { type PrFacts, prFacts } from "./facts";
import type { Column, Holder, PullRequest, Triage, TriagedPull, TurnKind } from "./model";

/** What a rule decides; the column and the copy are derived from it. */
interface Turn {
  kind: TurnKind;
  holder: Holder;
  actor: string | null;
  at: string | null;
  count?: number;
  viaTeam?: boolean;
}

/** One line of the table: the first rule that answers decides the PR. */
type Rule = (f: PrFacts) => Turn | null;

const ME: Holder = { kind: "me" };

/** My PR. Order is priority: what blocks everything (conflicts) first, then what people said, then what waits. */
const MINE: Rule[] = [
  // Conflicts lead, matching the PR's next step (nextStep.ts). No event marks when they appeared.
  (f) => (f.conflicting ? { kind: "conflicts", holder: ME, actor: null, at: f.pr.updatedAt } : null),
  (f) => {
    const [t] = f.threadsForMe;
    return t === undefined
      ? null
      : { kind: "thread", holder: ME, actor: t.lastAuthor, at: t.lastAt, count: f.threadsForMe.length };
  },
  (f) =>
    f.changesPending === null
      ? null
      : { kind: "changes", holder: ME, actor: f.changesPending.author, at: f.changesPending.submittedAt },
  (f) => (f.ciFailing ? { kind: "ci", holder: ME, actor: null, at: f.pr.lastCommitAt } : null),
  (f) =>
    f.newComment === null ? null : { kind: "comment", holder: ME, actor: f.newComment.author, at: f.newComment.at },
  // Changes were requested, I pushed, and nobody asked the reviewer back: they will not look on their own.
  (f) => {
    const [who] = f.askAgain;
    return who === undefined || f.pr.isDraft
      ? null
      : { kind: "ask-again", holder: ME, actor: who, at: f.pr.lastCommitAt, count: f.askAgain.length };
  },
  (f) =>
    f.approved && f.blockedBy.length > 0
      ? {
          kind: "blocked-approved",
          holder: { kind: "dependency", refs: f.blockedBy },
          actor: null,
          at: f.approval?.submittedAt ?? f.pr.updatedAt,
        }
      : null,
  (f) =>
    f.approved
      ? { kind: "merge", holder: ME, actor: f.approval?.author ?? null, at: f.approval?.submittedAt ?? null }
      : null,
  (f) =>
    f.pr.isDraft ? { kind: "draft", holder: { kind: "nobody", why: "draft" }, actor: null, at: f.pr.createdAt } : null,
  // Ready, nobody asked, but it can only merge after others: the dependency holds it, not a missing reviewer.
  (f) =>
    f.blockedBy.length > 0 && f.pendingReviewers.length === 0
      ? { kind: "blocked", holder: { kind: "dependency", refs: f.blockedBy }, actor: null, at: f.readyAt }
      : null,
  (f) => {
    const [first] = f.pendingReviewers;
    if (first === undefined) return null;
    return {
      kind: f.reviewed ? "rereview-wait" : "review-wait",
      holder: { kind: "people", logins: f.pendingReviewers },
      actor: first,
      at: f.askedAt(f.pendingReviewers) ?? f.readyAt,
      count: f.pendingReviewers.length,
    };
  },
  (f) => ({ kind: "unrequested", holder: { kind: "nobody", why: "unrequested" }, actor: null, at: f.readyAt }),
];

/** Someone else's PR: it is mine to act on only when I am answered, asked, or the code moved under my review. */
const THEIRS: Rule[] = [
  (f) => {
    const [t] = f.threadsForMe;
    return t === undefined
      ? null
      : { kind: "reply", holder: ME, actor: t.lastAuthor, at: t.lastAt, count: f.threadsForMe.length };
  },
  (f) =>
    f.requestedOfMe
      ? {
          kind: "review-requested",
          holder: ME,
          actor: f.pr.author,
          at: f.askedAt([...f.pr.requestedReviewers, ...(f.pr.requestedTeams ?? [])]) ?? f.readyAt,
          viaTeam: f.requestedViaTeam,
        }
      : null,
  (f) =>
    f.pushedSinceMyReview && !f.pr.isDraft
      ? { kind: "review-again", holder: ME, actor: f.pr.author, at: f.pr.lastCommitAt }
      : null,
  (f) => {
    const holder: Holder = { kind: "author", login: f.pr.author };
    const kind: TurnKind = f.approved
      ? "approved"
      : f.pr.reviewDecision === "CHANGES_REQUESTED"
        ? "changes-requested"
        : f.pr.isDraft
          ? "draft"
          : "open";
    return { kind, holder, actor: f.pr.author, at: f.pr.updatedAt };
  },
];

const REVIEW_KINDS: ReadonlySet<TurnKind> = new Set(["review-requested", "review-again"]);

function columnOf(turn: Turn, mine: boolean): Column {
  if (turn.holder.kind === "me") return REVIEW_KINDS.has(turn.kind) ? "reviewRequested" : "myTurn";
  return mine ? "waiting" : "others";
}

const more = (count: number | undefined): string => (count !== undefined && count > 1 ? ` (+${count - 1})` : "");

/** The card's line, in pt-BR, after the actor's name. Copy lives here so rules stay about decisions only. */
export function describe(t: Pick<Triage, "kind" | "count" | "viaTeam">): string {
  switch (t.kind) {
    case "conflicts":
      return "tem conflitos para resolver";
    case "thread":
      return `comentou numa thread${more(t.count)}`;
    case "changes":
      return "pediu mudanças";
    case "ci":
      return "CI falhando";
    case "comment":
      return "comentou";
    case "ask-again":
      return `pediu mudanças; peça nova revisão${more(t.count)}`;
    case "merge":
      return "aprovou, pronta para merge";
    case "blocked-approved":
      return "aprovada, esperando dependência";
    case "blocked":
      return "esperando dependência";
    case "draft":
      return "rascunho";
    case "review-wait":
      return `vai revisar${more(t.count)}`;
    case "rereview-wait":
      return `vai revisar de novo${more(t.count)}`;
    case "unrequested":
      return "ninguém foi chamado para revisar";
    case "reply":
      return `respondeu você${more(t.count)}`;
    case "review-requested":
      return t.viaTeam === true ? "pediu review do seu time" : "pediu seu review";
    case "review-again":
      return "fez commits depois do seu review";
    case "approved":
      return "aprovada";
    case "changes-requested":
      return "com mudanças pedidas";
    case "open":
      return "aberta";
  }
}

/** Decides whose turn a PR is, from `me`'s point of view. `waitingOn` lists open PRs that must merge first. */
export function triage(pr: PullRequest, me: string, waitingOn: string[] = []): Triage {
  const f = prFacts(pr, me, waitingOn);
  const rules = f.mine ? MINE : THEIRS;
  let turn: Turn | null = null;
  for (const rule of rules) {
    turn = rule(f);
    if (turn !== null) break;
  }
  // The last rule of each table always answers.
  const t = turn ?? { kind: "open", holder: { kind: "author", login: pr.author }, actor: pr.author, at: pr.updatedAt };
  return {
    column: columnOf(t, f.mine),
    kind: t.kind,
    holder: t.holder,
    actor: t.actor,
    at: t.at,
    reason: describe(t),
    ...(t.count === undefined ? {} : { count: t.count }),
    ...(t.viaTeam === true ? { viaTeam: true } : {}),
  };
}

// Columns where the ball is with me show the longest-waiting first (the slow tail is what hurts); the rest show the
// latest activity first.
const OLDEST_FIRST: ReadonlySet<Column> = new Set(["myTurn", "reviewRequested"]);

/** Groups PRs by column and orders each one. */
export function board(prs: PullRequest[], me: string): Record<Column, TriagedPull[]> {
  const groups: Record<Column, TriagedPull[]> = { myTurn: [], reviewRequested: [], waiting: [], others: [] };
  const deps = dependencyIndex(prs);
  for (const pr of prs) {
    const open = deps.get(pr.id)?.blockedBy.filter((d): boolean => d.pr !== null) ?? [];
    const t = triage(pr, me, open.map(shortRef));
    groups[t.column].push({ pr, triage: t });
  }
  const at = (p: TriagedPull): number => Date.parse(p.triage.at ?? p.pr.updatedAt);
  for (const [column, items] of Object.entries(groups) as [Column, TriagedPull[]][]) {
    items.sort((a, b): number => (OLDEST_FIRST.has(column) ? at(a) - at(b) : at(b) - at(a)));
  }
  return groups;
}
