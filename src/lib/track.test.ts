import { describe, expect, it } from "vitest";

import type { PullRequest } from "./model";
import { prCrew, prTrack } from "./track";

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
    expect(track.marks[2]?.label).toBe("bia aprovou há 4h");
  });

  it("keeps a PR with no events idle since it opened", () => {
    expect(prTrack(pr({}), NOW)).toEqual({ marks: [], idleFrom: 0 });
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
