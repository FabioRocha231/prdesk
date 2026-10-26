import { describe, expect, it } from "vitest";

import { type Live, mergeLive, type PullCache, staleIds } from "./github";

type Raw = PullCache[string];

const live = (id: string, updatedAt: string): Live => ({
  id,
  updatedAt,
  isDraft: false,
  reviewDecision: null,
  mergeable: "MERGEABLE",
  commits: { nodes: [] },
});

describe("incremental sync", () => {
  const cached = { id: "a", updatedAt: "t1", title: "old", mergeStateStatus: "CLEAN" } as unknown as Raw;

  it("refetches only new or changed PRs", () => {
    const cache: PullCache = { a: cached };
    expect(staleIds([live("a", "t1"), live("b", "t1")], cache)).toEqual(["b"]);
    expect(staleIds([live("a", "t2")], cache)).toEqual(["a"]);
  });

  it("keeps cached details under fresh live fields and drops PRs that left", () => {
    const next = mergeLive([live("a", "t1")], { a: cached, gone: cached }, {}, new Map([["a", "BEHIND"]]));
    expect(Object.keys(next)).toEqual(["a"]);
    expect(next.a).toMatchObject({ title: "old", mergeStateStatus: "BEHIND" });
  });

  it("prefers freshly fetched details over the cache", () => {
    const fresh = { a: { ...cached, title: "new" } as Raw };
    expect(mergeLive([live("a", "t2")], { a: cached }, fresh).a).toMatchObject({ title: "new", updatedAt: "t2" });
  });
});
