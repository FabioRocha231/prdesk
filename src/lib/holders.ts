import { COLUMNS, type Column, type TriagedPull, type TurnKind } from "./model";

/** A group of the PR list: whoever holds the ball for these PRs. */
export interface HolderGroup {
  key: string;
  /** "me": my PRs waiting on me; "review": others' PRs waiting on me; "stale": nothing moved in weeks. */
  kind: "me" | "review" | "person" | "nobody" | "team" | "stale";
  /** The person, as GitHub wrote the login; empty for the others. */
  login: string;
  items: TriagedPull[];
}

/** Days without any activity after which a PR leaves its group for "Paradas". */
export const STALE_DAYS = 21;
const DAY_MS = 86_400_000;

/** What the PR needs, in two or three words. The row's title and reason say which PR and why. */
export const VERB: Record<TurnKind, string> = {
  conflicts: "Resolver conflitos",
  thread: "Responder",
  changes: "Fazer mudanças",
  ci: "Consertar o CI",
  comment: "Responder",
  "ask-again": "Pedir nova revisão",
  merge: "Mergear",
  "blocked-approved": "Espera outra PR",
  blocked: "Espera outra PR",
  draft: "Rascunho",
  "review-wait": "Revisando",
  "rereview-wait": "Revisando de novo",
  unrequested: "Pedir revisão",
  reply: "Ver resposta",
  "review-requested": "Revisar",
  "review-again": "Revisar de novo",
  approved: "Aprovada",
  "changes-requested": "Mudanças pedidas",
  open: "Aberta",
};

const at = (t: TriagedPull): number => Date.parse(t.triage.at ?? t.pr.updatedAt);

/**
 * Regroups the board by who holds the ball: my PRs waiting on me, then others' PRs I have to review, then each person
 * holding my PRs (busiest first), the ones nobody is looking at, the team's PRs, and last whatever has not moved in
 * STALE_DAYS. Every lane shows the longest-waiting first, except the team's and the stale ones, latest activity first.
 * A review already approved by someone else goes to the end of its lane: the request holds, but nothing waits on it.
 */
export function holderGroups(groups: Record<Column, TriagedPull[]>, now: number = Date.now()): HolderGroup[] {
  const me: TriagedPull[] = [];
  const review: TriagedPull[] = [];
  const people = new Map<string, HolderGroup>();
  const nobody: TriagedPull[] = [];
  const team: TriagedPull[] = [];
  const stale: TriagedPull[] = [];
  const cutoff = now - STALE_DAYS * DAY_MS;
  for (const column of COLUMNS) {
    for (const item of groups[column]) {
      const h = item.triage.holder;
      if (Date.parse(item.pr.updatedAt) < cutoff) stale.push(item);
      else if (h.kind === "me") (column === "reviewRequested" ? review : me).push(item);
      else if (h.kind === "people") {
        const login = h.logins[0] ?? "";
        const key = `person:${login.toLowerCase()}`;
        const lane = people.get(key) ?? { key, kind: "person", login, items: [] };
        lane.items.push(item);
        people.set(key, lane);
      } else if (h.kind === "author") team.push(item);
      else nobody.push(item);
    }
  }
  const oldest = (a: TriagedPull, b: TriagedPull): number => at(a) - at(b);
  const latest = (a: TriagedPull, b: TriagedPull): number => at(b) - at(a);
  const approved = (t: TriagedPull): number => (t.pr.reviewDecision === "APPROVED" ? 1 : 0);
  const all: HolderGroup[] = [
    { key: "me", kind: "me", login: "", items: me.sort(oldest) },
    {
      key: "review",
      kind: "review",
      login: "",
      items: review.sort((a, b) => approved(a) - approved(b) || oldest(a, b)),
    },
    ...[...people.values()]
      .map((l): HolderGroup => ({ ...l, items: l.items.sort(oldest) }))
      .sort((a, b): number => b.items.length - a.items.length || a.login.localeCompare(b.login)),
    { key: "nobody", kind: "nobody", login: "", items: nobody.sort(oldest) },
    { key: "team", kind: "team", login: "", items: team.sort(latest) },
    { key: "stale", kind: "stale", login: "", items: stale.sort(latest) },
  ];
  return all.filter((l): boolean => l.items.length > 0);
}

// Hues that read on both themes and stay apart from the action colours' meaning by being small dots.
const REPO_HUES = ["#f76b15", "#12a594", "#d6409f", "#3e63dd", "#8e4ec6", "#46a758", "#a18072", "#05a2c2"];

/** A repo keeps its colour everywhere and across sessions: it comes from its name. */
export function repoColor(repo: string): string {
  let hash = 0;
  for (const ch of repo) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return REPO_HUES[hash % REPO_HUES.length] ?? "#888";
}
