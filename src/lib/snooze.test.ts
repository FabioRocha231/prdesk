import { describe, expect, it } from "vitest";

import type { PullRequest } from "./model";
import { isSnoozed, wakeTime } from "./snooze";

// Wednesday 2026-10-28, 15:00 local time.
const NOW = new Date(2026, 9, 28, 15, 0, 0);
const pr = { updatedAt: "2026-10-28T10:00:00Z" } as PullRequest;

describe("wakeTime", () => {
  it("wakes tomorrow and next Monday at 9h", () => {
    expect(new Date(wakeTime("tomorrow", NOW) ?? 0)).toEqual(new Date(2026, 9, 29, 9, 0, 0));
    expect(new Date(wakeTime("monday", NOW) ?? 0)).toEqual(new Date(2026, 10, 2, 9, 0, 0));
    expect(wakeTime("change", NOW)).toBeNull();
  });

  it("on a Monday, monday means the next one", () => {
    expect(new Date(wakeTime("monday", new Date(2026, 10, 2, 8, 0, 0)) ?? 0)).toEqual(new Date(2026, 10, 9, 9, 0, 0));
  });
});

describe("isSnoozed", () => {
  it("stays hidden until the deadline or new activity", () => {
    const snooze = { until: NOW.getTime() + 1000, updatedAt: pr.updatedAt };
    expect(isSnoozed(snooze, pr, NOW.getTime())).toBe(true);
    expect(isSnoozed(snooze, pr, NOW.getTime() + 2000)).toBe(false);
    expect(isSnoozed(snooze, { ...pr, updatedAt: "2026-10-28T11:00:00Z" }, NOW.getTime())).toBe(false);
    expect(isSnoozed({ until: null, updatedAt: pr.updatedAt }, pr, NOW.getTime() + 1e9)).toBe(true);
  });
});
