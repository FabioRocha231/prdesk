import { describe, expect, it } from "vitest";

import { activeFilter, pickOrg, reposByOrg, toggleRepo } from "./repoFilter";

describe("repoFilter", () => {
  it("groups repos by org in sorted order, once each", () => {
    expect(reposByOrg(["b/x", "a/z", "a/y", "a/z"])).toEqual([
      ["a", ["a/y", "a/z"]],
      ["b", ["b/x"]],
    ]);
  });

  it("drops repos that left the board", () => {
    expect(activeFilter(["a/y", "gone/r"], ["a/y", "b/x"])).toEqual(["a/y"]);
  });

  it("toggles a repo and flips an org between only-it and everything", () => {
    expect(toggleRepo(["a/y"], "b/x")).toEqual(["a/y", "b/x"]);
    expect(toggleRepo(["a/y", "b/x"], "a/y")).toEqual(["b/x"]);
    expect(pickOrg(["b/x"], ["a/y", "a/z"])).toEqual(["a/y", "a/z"]);
    expect(pickOrg(["a/z", "a/y"], ["a/y", "a/z"])).toEqual([]);
  });
});
