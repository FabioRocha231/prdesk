import { describe, expect, it } from "vitest";

import type { PullRequest } from "./model";
import { clusterMarks, prCrew, prTrack, sizeBand, stackPosition, workingHours } from "./track";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

const pr = (overrides: Partial<PullRequest>): PullRequest =>
  ({
    createdAt: hoursAgo(100),
    lastCommitAt: null,
    reviews: [],
    requestedReviewers: [],
    threads: [],
    lastComment: null,
    ...overrides,
  }) as PullRequest;

describe("prTrack", () => {
  it("places events on a square-root scale and starts the idle stretch at the last one", () => {
    const track = prTrack(
      pr({
        lastCommitAt: hoursAgo(25),
        reviews: [
          { author: "bia", state: "APPROVED", submittedAt: hoursAgo(4) },
          { author: "coderabbitai", state: "COMMENTED", submittedAt: hoursAgo(1), isBot: true },
          { author: "caio", state: "DISMISSED", submittedAt: hoursAgo(2) },
        ],
        threads: [
          { isResolved: false, firstAuthor: "bia", lastAuthor: "bia", lastIsBot: false, lastAt: hoursAgo(9) },
          { isResolved: true, firstAuthor: "bia", lastAuthor: "bia", lastIsBot: false, lastAt: hoursAgo(3) },
        ],
      }),
      NOW,
    );
    expect(track.marks.map((m) => [m.kind, Number(m.at.toFixed(2))])).toEqual([
      ["commit", 0.5],
      ["thread", 0.7],
      ["approved", 0.8],
    ]);
    expect(track.idleFrom).toBeCloseTo(0.8);
    expect(track.idleSince).toBe(Date.parse(hoursAgo(4)));
    expect(track.marks[2]?.label).toBe("bia aprovou há 4h");
  });

  it("keeps a PR with no events idle since it opened", () => {
    expect(prTrack(pr({}), NOW)).toEqual({ marks: [], idleFrom: 0, idleSince: Date.parse(hoursAgo(100)) });
  });
});

describe("prCrew", () => {
  it("lists reviewers by their latest word and the ones still asked", () => {
    expect(
      prCrew(
        pr({
          reviews: [
            { author: "bia", state: "APPROVED", submittedAt: hoursAgo(4) },
            { author: "caio", state: "CHANGES_REQUESTED", submittedAt: hoursAgo(8) },
            { author: "coderabbitai", state: "COMMENTED", submittedAt: hoursAgo(1), isBot: true },
          ],
          requestedReviewers: ["caio", "dani"],
        }),
      ),
    ).toEqual([
      { login: "bia", state: "approved" },
      { login: "caio", state: "asked" },
      { login: "dani", state: "asked" },
    ]);
  });
});

describe("clusterMarks", () => {
  it("draws close marks as one, speaking with the most important kind", () => {
    const marks = [
      { kind: "commit" as const, at: 0.5, label: "a" },
      { kind: "changes" as const, at: 0.52, label: "b" },
      { kind: "comment" as const, at: 0.54, label: "c" },
      { kind: "approved" as const, at: 0.9, label: "d" },
    ];
    expect(clusterMarks(marks)).toEqual([
      { kind: "changes", at: 0.5, labels: ["a", "b", "c"] },
      { kind: "approved", at: 0.9, labels: ["d"] },
    ]);
  });
});

describe("workingHours", () => {
  it("leaves the weekend out", () => {
    // Friday 2026-10-23 12:00 to Monday 2026-10-26 12:00, local time: 12h Friday + 12h Monday.
    expect(workingHours(new Date(2026, 9, 23, 12).getTime(), new Date(2026, 9, 26, 12).getTime())).toBe(24);
    expect(workingHours(new Date(2026, 9, 24, 8).getTime(), new Date(2026, 9, 24, 20).getTime())).toBe(0);
  });
});

describe("stackPosition", () => {
  const p = (id: string, headRef: string, baseRef: string) =>
    ({ id, repo: "acme/api", headRef, baseRef, isCrossRepository: false }) as PullRequest;

  it("counts the PRs built on each other's branches", () => {
    const pulls = [
      p("a", "feat/a", "main"),
      p("b", "feat/b", "feat/a"),
      p("c", "feat/c", "feat/b"),
      p("x", "x", "main"),
    ];
    expect(stackPosition(pulls[1] as PullRequest, pulls)).toEqual({ index: 2, total: 3 });
    expect(stackPosition(pulls[0] as PullRequest, pulls)).toEqual({ index: 1, total: 3 });
    expect(stackPosition(pulls[3] as PullRequest, pulls)).toBeNull();
  });
});

describe("sizeBand", () => {
  it("bands by lines touched", () => {
    expect(sizeBand({ additions: 30, deletions: 20 })).toBe("P");
    expect(sizeBand({ additions: 300, deletions: 100 })).toBe("M");
    expect(sizeBand({ additions: 300, deletions: 101 })).toBe("G");
  });
});
