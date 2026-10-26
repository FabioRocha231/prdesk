import { describe, expect, it } from "vitest";

import type { PullRequest } from "./model";
import { board, triage } from "./triage";

const ME = "ana";

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "PR_1",
    number: 1,
    title: "Fix auth refresh",
    url: "https://github.com/acme/api/pull/1",
    repo: "acme/api",
    repoUrl: "https://github.com/acme/api",
    isDraft: false,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
    author: ME,
    headRef: "fix/auth",
    baseRef: "main",
    isCrossRepository: false,
    branch: "ok",
    dependsOn: [],
    reviewDecision: null,
    ciState: "SUCCESS",
    lastCommitAt: "2026-10-01T10:00:00Z",
    requestedReviewers: [],
    reviews: [],
    threads: [],
    lastComment: null,
    ...overrides,
  };
}

describe("triage of my PRs", () => {
  it("waits instead of merging while a dependency is still open", () => {
    expect(triage(pr({ reviewDecision: "APPROVED" }), ME, ["core#9"])).toMatchObject({
      column: "waiting",
      reason: "aprovada, esperando dependência",
    });
  });

  it("is my turn when the branch has conflicts", () => {
    expect(triage(pr({ branch: "conflicts" }), ME)).toMatchObject({
      column: "myTurn",
      reason: "tem conflitos para resolver",
    });
  });

  it("is my turn when someone else spoke last in an open thread", () => {
    const t = triage(
      pr({
        threads: [
          {
            isResolved: false,
            firstAuthor: "bia",
            lastIsBot: false,
            lastAuthor: "bia",
            lastAt: "2026-10-02T09:00:00Z",
          },
          {
            isResolved: false,
            firstAuthor: "bia",
            lastIsBot: false,
            lastAuthor: ME,
            lastAt: "2026-10-02T11:00:00Z",
          },
        ],
      }),
      ME,
    );
    expect(t).toMatchObject({ column: "myTurn", actor: "bia" });
  });

  it("ignores resolved threads and threads I answered", () => {
    const t = triage(
      pr({
        threads: [
          {
            isResolved: true,
            firstAuthor: "bia",
            lastIsBot: false,
            lastAuthor: "bia",
            lastAt: "2026-10-02T09:00:00Z",
          },
        ],
        reviews: [{ author: "bia", state: "COMMENTED", submittedAt: "2026-10-02T09:00:00Z" }],
      }),
      ME,
    );
    expect(t.column).toBe("waiting");
  });

  it("is my turn when changes were requested after my last commit, not before", () => {
    const review = { author: "bia", state: "CHANGES_REQUESTED", submittedAt: "2026-10-02T09:00:00Z" };
    expect(triage(pr({ reviews: [review] }), ME).column).toBe("myTurn");
    expect(triage(pr({ reviews: [review], lastCommitAt: "2026-10-03T09:00:00Z" }), ME).column).toBe("waiting");
  });

  it("is my turn when CI fails or the PR is approved", () => {
    expect(triage(pr({ ciState: "FAILURE" }), ME).reason).toBe("CI falhando");
    expect(triage(pr({ reviewDecision: "APPROVED" }), ME).reason).toBe("aprovou, pronta para merge");
  });

  it("waits when nobody reviewed yet", () => {
    expect(triage(pr(), ME)).toMatchObject({ column: "waiting", reason: "sem review ainda" });
  });
});

describe("triage of other people's PRs", () => {
  const theirs = { author: "caio" };

  it("is my turn when someone answered a thread I started", () => {
    const t = triage(
      pr({
        ...theirs,
        threads: [
          {
            isResolved: false,
            firstAuthor: ME,
            lastIsBot: false,
            lastAuthor: "caio",
            lastAt: "2026-10-02T09:00:00Z",
          },
        ],
      }),
      ME,
    );
    expect(t).toMatchObject({ column: "myTurn", actor: "caio" });
  });

  it("is a review request when I am a requested reviewer or new commits landed after my review", () => {
    expect(triage(pr({ ...theirs, requestedReviewers: [ME] }), ME).column).toBe("reviewRequested");
    const reviewed = pr({
      ...theirs,
      reviews: [{ author: ME, state: "COMMENTED", submittedAt: "2026-10-01T09:00:00Z" }],
      lastCommitAt: "2026-10-02T09:00:00Z",
    });
    expect(triage(reviewed, ME).column).toBe("reviewRequested");
  });

  it("falls back to others", () => {
    expect(triage(pr(theirs), ME).column).toBe("others");
  });
});

describe("board", () => {
  it("puts the most recent activity first", () => {
    const older = pr({ id: "a", createdAt: "2026-09-01T00:00:00Z" });
    const newer = pr({ id: "b", createdAt: "2026-10-01T00:00:00Z" });
    expect(board([newer, older], ME).waiting.map((p): string => p.pr.id)).toEqual(["b", "a"]);
  });
});

describe("bot noise", () => {
  it("does not make it my turn when a bot spoke last in a thread", () => {
    const t = triage(
      pr({
        threads: [
          {
            isResolved: false,
            firstAuthor: "coderabbitai",
            lastIsBot: true,
            lastAuthor: "coderabbitai",
            lastAt: "2026-10-02T09:00:00Z",
          },
        ],
      }),
      ME,
    );
    expect(t.column).toBe("waiting");
  });
});
