import { describe, expect, it } from "vitest";

import { DEFAULT_LAYOUT, gridTemplate, MIN_LANE_PX, moveLane, normalizeLayout, resizePair } from "./lanes";

describe("lanes", () => {
  it("repairs a stored layout and keeps every column", () => {
    const layout = normalizeLayout({
      order: ["waiting", "nope", "waiting"],
      weights: { myTurn: 99 },
      collapsed: { others: true },
    });
    expect(layout.order).toEqual(["waiting", "myTurn", "reviewRequested", "others"]);
    expect(layout.weights.myTurn).toBe(5);
    expect(layout.collapsed.others).toBe(true);
    expect(normalizeLayout("garbage")).toEqual(DEFAULT_LAYOUT);
  });

  it("builds tracks with gutters and fixed strips for folded lanes", () => {
    const layout = { ...DEFAULT_LAYOUT, collapsed: { ...DEFAULT_LAYOUT.collapsed, others: true } };
    expect(gridTemplate(layout)).toBe("minmax(220px, 1fr) 28px minmax(220px, 1fr) 28px minmax(220px, 1fr) 28px 44px");
  });

  it("moves a lane and resizes a pair without crossing the minimum", () => {
    expect(moveLane(["myTurn", "reviewRequested", "waiting", "others"], "others", 0)).toEqual([
      "others",
      "myTurn",
      "reviewRequested",
      "waiting",
    ]);
    const w = resizePair(DEFAULT_LAYOUT.weights, "myTurn", "waiting", 400, 400, 100);
    expect(w.myTurn / (w.myTurn + w.waiting)).toBeCloseTo(500 / 800);
    const squeezed = resizePair(DEFAULT_LAYOUT.weights, "myTurn", "waiting", 300, 300, -500);
    expect(squeezed.myTurn / (squeezed.myTurn + squeezed.waiting)).toBeCloseTo(MIN_LANE_PX / 600);
  });
});
