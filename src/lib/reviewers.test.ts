import { describe, expect, it } from "vitest";

import type { PullRequest } from "./model";
import { needsReviewers, usualReviewers } from "./reviewers";

const pr = (overrides: Partial<PullRequest>): PullRequest =>
  ({
    repo: "acme/api",
    author: "bob",
    isDraft: false,
    requestedReviewers: [],
    reviews: [],
    ...overrides,
  }) as PullRequest;

const review = (author: string, isBot = false) => ({
  author,
  state: "APPROVED",
  submittedAt: "2026-10-01T00:00:00Z",
  ...(isBot ? { isBot } : {}),
});

describe("usualReviewers", () => {
  it("ranks people who review in the repo, without bots, me or other repos", () => {
    const pulls = [
      pr({ reviews: [review("bia"), review("coderabbitai", true)], requestedReviewers: ["caio"] }),
      pr({ author: "ana", reviews: [review("bia")], requestedReviewers: ["bia"] }),
      pr({ author: "caio", reviews: [review("ana"), review("dani")] }),
      pr({ repo: "acme/web", reviews: [review("eva")], requestedReviewers: ["eva"] }),
    ];
    expect(usualReviewers(pulls, "acme/api", "ana")).toEqual(["bia", "caio"]);
    expect(usualReviewers(pulls, "acme/api", "ana", 5)).toEqual(["bia", "caio", "dani"]);
    expect(usualReviewers(pulls, "acme/none", "ana")).toEqual([]);
  });
});

describe("needsReviewers", () => {
  it("is true for drafts and for PRs nobody (but bots) looked at", () => {
    expect(needsReviewers(pr({ isDraft: true, requestedReviewers: ["bia"] }))).toBe(true);
    expect(needsReviewers(pr({ reviews: [review("coderabbitai", true)] }))).toBe(true);
    expect(needsReviewers(pr({ requestedReviewers: ["bia"] }))).toBe(false);
    expect(needsReviewers(pr({ reviews: [review("bia")] }))).toBe(false);
  });
});
