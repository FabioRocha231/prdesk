import { describe, expect, it } from "vitest";

import { layoutGraph, mainlineTip, mergedPr, readRefs, remoteSlug } from "./graph";
import type { GraphCommit } from "./ipc";

const c = (hash: string, parents: string[] = []): GraphCommit => ({
  hash,
  parents,
  refs: [],
  subject: hash,
  author: "a",
  time: 0,
});

describe("layoutGraph", () => {
  it("keeps a straight line in one lane", () => {
    const g = layoutGraph([c("c", ["b"]), c("b", ["a"]), c("a")]);
    expect(g.lanes).toEqual([0, 0, 0]);
    expect(g.width).toBe(1);
  });

  it("branches out and merges back", () => {
    // m merges f into main; f forked from a.
    const g = layoutGraph([c("m", ["b", "f"]), c("f", ["a"]), c("b", ["a"]), c("a")]);
    expect(g.lanes).toEqual([0, 1, 0, 0]);
    expect(g.width).toBe(2);
    const merge = g.edges.find((e) => e.merge);
    expect(merge).toMatchObject({ from: 0, to: 1, toLane: 1 });
    // f's line converges into a's lane at a's row.
    expect(g.edges.find((e) => e.from === 1)).toMatchObject({ via: 1, to: 3, toLane: 0 });
  });

  it("keeps the main branch on the left even when a feature tip is newer", () => {
    const commits = [c("f", ["a"]), c("m", ["a"]), c("a")];
    expect(layoutGraph(commits).lanes).toEqual([0, 1, 0]);
    expect(layoutGraph(commits, "m").lanes).toEqual([1, 0, 0]);
    expect(mainlineTip([{ ...c("m"), refs: ["origin/main", "origin/HEAD"] }, c("f")])).toBe("m");
  });

  it("runs lines off the bottom when the parent was not loaded", () => {
    const g = layoutGraph([c("b", ["a"])]);
    expect(g.edges[0]).toMatchObject({ to: 1, toLane: 0 });
  });
});

describe("refs and subjects", () => {
  it("reads decorations", () => {
    expect(readRefs(["HEAD -> main", "origin/main", "origin/HEAD", "tag: v1", "origin/feat/x"])).toEqual([
      { name: "main", kind: "head" },
      { name: "v1", kind: "tag" },
      { name: "feat/x", kind: "remote" },
    ]);
  });

  it("finds merged PR numbers and remote slugs", () => {
    expect(mergedPr("Merge pull request #12 from a/b")).toBe(12);
    expect(mergedPr("fix: thing (#1958)")).toBe(1958);
    expect(mergedPr("fix(#12): thing")).toBeNull();
    expect(remoteSlug("git@github.com:ggCheckout/saas-checkout.git")).toBe("ggCheckout/saas-checkout");
    expect(remoteSlug("https://github.com/a/b")).toBe("a/b");
    expect(remoteSlug(null)).toBeNull();
  });
});
