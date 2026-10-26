import type { GraphCommit } from "./ipc";

/** A line from a commit down to one of its parents: leaves the node, runs in lane `via`, joins the parent's lane. */
export interface Edge {
  from: number;
  fromLane: number;
  via: number;
  /** Row of the parent; `rows` when the parent is older than what was loaded (the line runs off the bottom). */
  to: number;
  toLane: number;
  /** A merge's second parent: the branch that came in. */
  merge: boolean;
}

export interface GraphLayout {
  /** Lane of each row's commit. */
  lanes: number[];
  edges: Edge[];
  /** Widest the graph gets, in lanes. */
  width: number;
}

function freeLane(active: (string | null)[]): number {
  const at = active.indexOf(null);
  if (at !== -1) return at;
  active.push(null);
  return active.length - 1;
}

/**
 * Classic lane assignment over commits in topological order (newest first): a commit takes the lane that was
 * waiting for it, its first parent keeps that lane, other parents open new ones. O(rows × lanes).
 */
export function layoutGraph(commits: GraphCommit[], mainline: string | null = null): GraphLayout {
  const rows = new Set(commits.map((c): string => c.hash));
  // Lane 0 is reserved for the main branch, so feature branches always grow to its right.
  const active: (string | null)[] = mainline !== null && rows.has(mainline) ? [mainline] : [];
  const waiting = new Map<string, Edge[]>();
  const lanes: number[] = [];
  const edges: Edge[] = [];
  let width = 0;

  commits.forEach((commit, row): void => {
    let lane = active.indexOf(commit.hash);
    if (lane === -1) lane = freeLane(active);
    // Every lane that was waiting for this commit converges here.
    for (let j = 0; j < active.length; j++) if (active[j] === commit.hash) active[j] = null;
    lanes[row] = lane;
    for (const e of waiting.get(commit.hash) ?? []) {
      e.to = row;
      e.toLane = lane;
    }
    waiting.delete(commit.hash);

    commit.parents.forEach((parent, k): void => {
      let via = active.indexOf(parent);
      if (k === 0 && via > lane && active[lane] === null) {
        // The leftmost child keeps the first parent so mainline stays a straight line on the left; the other lane
        // keeps waiting too and converges at the parent, so no other branch reuses it in between.
        via = lane;
        active[lane] = parent;
      } else if (via === -1) {
        via = k === 0 && active[lane] === null ? lane : freeLane(active);
        active[via] = parent;
      }
      const edge: Edge = { from: row, fromLane: lane, via, to: commits.length, toLane: via, merge: k > 0 };
      edges.push(edge);
      if (rows.has(parent)) waiting.set(parent, [...(waiting.get(parent) ?? []), edge]);
    });
    while (active.length > 0 && active.at(-1) === null) active.pop();
    width = Math.max(width, lane + 1, active.length);
  });
  return { lanes, edges, width };
}

export type RefKind = "head" | "local" | "remote" | "tag";

export interface RefLabel {
  /** Branch name without "origin/", or the tag name. */
  name: string;
  kind: RefKind;
}

/** Decorations of one commit, with origin/x and a local x at the same commit shown once. */
export function readRefs(refs: string[]): RefLabel[] {
  const out = new Map<string, RefLabel>();
  for (const raw of refs) {
    if (raw === "HEAD" || raw.endsWith("/HEAD")) continue;
    if (raw.startsWith("tag: ")) {
      out.set(`tag:${raw.slice(5)}`, { name: raw.slice(5), kind: "tag" });
      continue;
    }
    if (raw.startsWith("HEAD -> ")) {
      const name = raw.slice(8);
      out.set(name, { name, kind: "head" });
      continue;
    }
    const remote = raw.match(/^[\w.-]+\/(.+)$/);
    const name = remote?.[1] ?? raw;
    // A local branch is a slashless name or one that does not come from a remote; local wins over remote.
    if (!out.has(name)) out.set(name, { name, kind: remote === null ? "local" : "remote" });
  }
  return [...out.values()];
}

/** Tip of the branch drawn on the left: `preferred` (a PR's base) or the remote default branch, else HEAD. */
export function mainlineTip(commits: GraphCommit[], preferred: string | null = null): string | null {
  const has = (test: (ref: string) => boolean): GraphCommit | undefined => commits.find((c) => c.refs.some(test));
  const tip =
    (preferred === null ? undefined : has((r): boolean => r === `origin/${preferred}`)) ??
    has((r): boolean => r.endsWith("/HEAD")) ??
    has((r): boolean => r.startsWith("HEAD -> "));
  return tip?.hash ?? null;
}

/** "Merge pull request #12 from …" or a squash "Title (#12)". */
export function mergedPr(subject: string): number | null {
  const m = subject.match(/^Merge pull request #(\d+)/) ?? subject.match(/\(#(\d+)\)\s*$/);
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** "git@github.com:owner/repo.git" or "https://github.com/owner/repo" → "owner/repo". */
export function remoteSlug(url: string | null): string | null {
  const m = url?.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m === null || m === undefined ? null : `${m[1]}/${m[2]}`;
}
