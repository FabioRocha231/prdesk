import type { PullRequest } from "./model";

/** A PR named by repo and number, the way people reference it in a description. */
export interface PrRef {
  repo: string;
  number: number;
}

// Lines that declare an ordering ("this one merges after that one"); plain mentions like "Refs" do not block.
const BLOCKING =
  /\b(depends? on|depende (?:de|do|da)|blocked by|bloquead[ao] por|requires|requer|needs|precisa (?:de|do|da)|merge after|mergear depois (?:de|do|da))\b/i;
const URL_REF = /https?:\/\/[^\s/]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const SHORT_REF = /(?:^|[\s(,[])((?:[\w.-]+\/[\w.-]+)?)#(\d+)\b/g;

/** PRs this description says must merge first. `#12` alone means the same repo. */
export function parseDependencies(body: string, repo: string): PrRef[] {
  const refs = new Map<string, PrRef>();
  const add = (r: string, n: string): void => {
    const ref = { repo: r === "" ? repo : r, number: Number(n) };
    refs.set(`${ref.repo.toLowerCase()}#${ref.number}`, ref);
  };
  for (const line of body.split("\n")) {
    if (!BLOCKING.test(line)) continue;
    for (const m of line.matchAll(URL_REF)) add(m[1] ?? "", m[2] ?? "0");
    for (const m of line.replace(URL_REF, " ").matchAll(SHORT_REF)) add(m[1] ?? "", m[2] ?? "0");
  }
  return [...refs.values()];
}

export function refKey(ref: PrRef): string {
  return `${ref.repo.toLowerCase()}#${ref.number}`;
}

/** One end of a dependency, resolved against the PRs on the board when possible. */
export interface DepLink extends PrRef {
  /** The open PR on the board, or null when it is merged, closed or outside the scopes. */
  pr: PullRequest | null;
}

export interface Deps {
  /** What this PR waits on. */
  blockedBy: DepLink[];
  /** Open PRs that wait on this one. */
  blocks: DepLink[];
}

/** Resolves every PR's declared dependencies in both directions. */
export function dependencyIndex(prs: PullRequest[]): Map<string, Deps> {
  const byKey = new Map(prs.map((p): [string, PullRequest] => [refKey(p), p]));
  const index = new Map<string, Deps>(prs.map((p): [string, Deps] => [p.id, { blockedBy: [], blocks: [] }]));
  for (const pr of prs) {
    for (const dep of pr.dependsOn) {
      if (refKey(dep) === refKey(pr)) continue;
      const target = byKey.get(refKey(dep)) ?? null;
      index.get(pr.id)?.blockedBy.push({ ...dep, pr: target });
      if (target !== null) index.get(target.id)?.blocks.push({ repo: pr.repo, number: pr.number, pr });
    }
  }
  return index;
}

/** Still waiting: at least one dependency is an open PR. */
export function isBlocked(deps: Deps | undefined): boolean {
  return deps?.blockedBy.some((d): boolean => d.pr !== null) ?? false;
}

export function shortRef(ref: PrRef): string {
  return `${ref.repo.split("/")[1] ?? ref.repo}#${ref.number}`;
}

/**
 * PRs linked by dependencies, each group split into merge steps: step 0 waits on nothing, step n waits only on
 * earlier steps, PRs in the same step can merge in any order. Groups of two or more open PRs; biggest first.
 */
export function chains(prs: PullRequest[], index: Map<string, Deps>): PullRequest[][][] {
  const byId = new Map(prs.map((p): [string, PullRequest] => [p.id, p]));
  const links = (id: string): string[] => {
    const d = index.get(id);
    return [...(d?.blockedBy ?? []), ...(d?.blocks ?? [])].flatMap((l): string[] => (l.pr === null ? [] : [l.pr.id]));
  };
  const position = new Map(prs.map((p, i): [string, number] => [p.id, i]));
  const seen = new Set<string>();
  const groups: PullRequest[][][] = [];
  for (const pr of prs) {
    if (seen.has(pr.id) || links(pr.id).length === 0) continue;
    const group: string[] = [];
    const stack = [pr.id];
    while (stack.length > 0) {
      const id = stack.pop() ?? "";
      if (seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      group.push(id);
      stack.push(...links(id));
    }
    // Kahn's order: a PR comes after every open PR it waits on; ties keep the board's order.
    group.sort((a, b): number => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    const inGroup = new Set(group);
    const waitsOn = (id: string): string[] =>
      (index.get(id)?.blockedBy ?? []).flatMap((l): string[] =>
        l.pr !== null && inGroup.has(l.pr.id) ? [l.pr.id] : [],
      );
    const placed = new Set<string>();
    const steps: PullRequest[][] = [];
    while (placed.size < group.length) {
      const ready = group.filter((id): boolean => !placed.has(id) && waitsOn(id).every((w): boolean => placed.has(w)));
      // A cycle ("A depends on B depends on A") would stall; put the rest in one last step.
      const next = ready.length > 0 ? ready : group.filter((id): boolean => !placed.has(id));
      for (const id of next) placed.add(id);
      steps.push(
        next.flatMap((id): PullRequest[] => {
          const p = byId.get(id);
          return p === undefined ? [] : [p];
        }),
      );
    }
    if (group.length > 1) groups.push(steps);
  }
  const size = (g: PullRequest[][]): number => g.reduce((n, step): number => n + step.length, 0);
  return groups.sort((a, b): number => size(b) - size(a));
}
