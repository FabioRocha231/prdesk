import { describe, expect, it } from "vitest";

import { type HolderGroup, holderGroups, repoColor } from "./holders";
import type { Column, Holder, PullRequest, TriagedPull } from "./model";

const item = (id: string, column: Column, holder: Holder, at: string): TriagedPull => ({
  pr: { id, author: "ana", repo: "acme/api", number: 1, updatedAt: at } as PullRequest,
  triage: { column, holder, kind: "open", reason: "", actor: null, at },
});

const groups = (items: TriagedPull[]): Record<Column, TriagedPull[]> => ({
  myTurn: items.filter((i) => i.triage.column === "myTurn"),
  reviewRequested: items.filter((i) => i.triage.column === "reviewRequested"),
  waiting: items.filter((i) => i.triage.column === "waiting"),
  others: items.filter((i) => i.triage.column === "others"),
});

const NOW = Date.parse("2026-01-04T00:00:00Z");

const ids = (g: { items: TriagedPull[] }): string[] => g.items.map((i) => i.pr.id);

describe("holderGroups", () => {
  it("groups by who holds the ball: me, my reviews, each person (busiest first), nobody, then the team", () => {
    const out = holderGroups(
      groups([
        item("team-old", "others", { kind: "author", login: "lia" }, "2026-01-01T00:00:00Z"),
        item("team-new", "others", { kind: "author", login: "lia" }, "2026-01-03T00:00:00Z"),
        item("dep", "waiting", { kind: "dependency", refs: ["core#1"] }, "2026-01-02T00:00:00Z"),
        item("bia-1", "waiting", { kind: "people", logins: ["Bia"] }, "2026-01-02T00:00:00Z"),
        item("caio", "waiting", { kind: "people", logins: ["caio"] }, "2026-01-01T00:00:00Z"),
        item("bia-2", "waiting", { kind: "people", logins: ["bia"] }, "2026-01-01T00:00:00Z"),
        item("review", "reviewRequested", { kind: "me" }, "2026-01-02T00:00:00Z"),
        item("mine", "myTurn", { kind: "me" }, "2026-01-03T00:00:00Z"),
      ]),
      NOW,
    );
    expect(out.map((g) => [g.kind, g.login])).toEqual([
      ["me", ""],
      ["review", ""],
      ["person", "Bia"],
      ["person", "caio"],
      ["nobody", ""],
      ["team", ""],
    ]);
    // My PRs and the reviews asked of me are separate lanes.
    expect(ids(out[0] as (typeof out)[0])).toEqual(["mine"]);
    expect(ids(out[1] as (typeof out)[0])).toEqual(["review"]);
    expect(ids(out[2] as (typeof out)[0])).toEqual(["bia-2", "bia-1"]);
    // The team's PRs show the latest activity first.
    expect(ids(out[5] as (typeof out)[0])).toEqual(["team-new", "team-old"]);
  });

  it("puts reviews someone else already approved at the end of my review lane", () => {
    const approved = item("approved", "reviewRequested", { kind: "me" }, "2026-01-01T00:00:00Z");
    approved.pr.reviewDecision = "APPROVED";
    const open = item("open", "reviewRequested", { kind: "me" }, "2026-01-02T00:00:00Z");
    expect(ids(holderGroups(groups([approved, open]), NOW)[0] as HolderGroup)).toEqual(["open", "approved"]);
  });

  it("moves anything idle for over three weeks to the stale lane, whoever holds it", () => {
    const out = holderGroups(
      groups([
        item("old-mine", "myTurn", { kind: "me" }, "2025-11-01T00:00:00Z"),
        item("fresh", "myTurn", { kind: "me" }, "2026-01-02T00:00:00Z"),
      ]),
      NOW,
    );
    expect(out.map((g) => [g.kind, ids(g)])).toEqual([
      ["me", ["fresh"]],
      ["stale", ["old-mine"]],
    ]);
  });

  it("leaves out empty groups", () => {
    expect(holderGroups(groups([]))).toEqual([]);
  });
});

describe("repoColor", () => {
  it("gives a repo the same colour every time", () => {
    expect(repoColor("acme/api")).toBe(repoColor("acme/api"));
    expect(repoColor("acme/api")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
