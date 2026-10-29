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

  it("is my turn when the branch has conflicts, ahead of failing CI", () => {
    expect(triage(pr({ branch: "conflicts", ciState: "FAILURE" }), ME)).toMatchObject({
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

  it("is my turn when changes were requested after my last commit", () => {
    const review = { author: "bia", state: "CHANGES_REQUESTED", submittedAt: "2026-10-02T09:00:00Z" };
    expect(triage(pr({ reviews: [review] }), ME)).toMatchObject({ column: "myTurn", kind: "changes" });
  });

  it("after a push answering changes, asks me to re-request unless the reviewer was asked again", () => {
    const review = { author: "bia", state: "CHANGES_REQUESTED", submittedAt: "2026-10-02T09:00:00Z" };
    const pushed = { reviews: [review], lastCommitAt: "2026-10-03T09:00:00Z" };
    expect(triage(pr(pushed), ME)).toMatchObject({ column: "myTurn", kind: "ask-again", actor: "bia" });
    expect(triage(pr({ ...pushed, requestedReviewers: ["bia"] }), ME)).toMatchObject({
      column: "waiting",
      kind: "rereview-wait",
      holder: { kind: "people", logins: ["bia"] },
    });
  });

  it("ignores changes requested by bots", () => {
    const bot = {
      author: "coderabbitai",
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-10-02T09:00:00Z",
      isBot: true,
    };
    expect(triage(pr({ reviews: [bot] }), ME).kind).toBe("unrequested");
  });

  it("says who holds a waiting PR and since when they were asked", () => {
    const t = triage(pr({ requestedReviewers: ["bia", "caio"], requestedAt: { bia: "2026-10-04T10:00:00Z" } }), ME);
    expect(t).toMatchObject({
      column: "waiting",
      kind: "review-wait",
      actor: "bia",
      count: 2,
      at: "2026-10-04T10:00:00Z",
      reason: "vai revisar (+1)",
      holder: { kind: "people", logins: ["bia", "caio"] },
    });
  });

  it("is held by nobody when it is a draft or nobody was asked, and by a dependency when only that is left", () => {
    expect(triage(pr({ isDraft: true }), ME).holder).toEqual({ kind: "nobody", why: "draft" });
    expect(triage(pr(), ME).holder).toEqual({ kind: "nobody", why: "unrequested" });
    expect(triage(pr(), ME, ["core#9"])).toMatchObject({
      kind: "blocked",
      holder: { kind: "dependency", refs: ["core#9"] },
    });
  });

  it("counts the waiting time from the ready-for-review event, not the last update", () => {
    expect(triage(pr({ readyAt: "2026-10-05T08:00:00Z" }), ME).at).toBe("2026-10-05T08:00:00Z");
  });

  it("is my turn when CI fails or the PR is approved", () => {
    expect(triage(pr({ ciState: "FAILURE" }), ME).reason).toBe("CI falhando");
    expect(triage(pr({ reviewDecision: "APPROVED" }), ME).reason).toBe("aprovou, pronta para merge");
  });

  it("waits when nobody reviewed yet", () => {
    expect(triage(pr(), ME)).toMatchObject({ column: "waiting", reason: "ninguém foi chamado para revisar" });
  });

  it("knows me whatever the case of my login", () => {
    expect(triage(pr({ author: "ANA", ciState: "FAILURE" }), ME).kind).toBe("ci");
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

  it("is a review request when I am a requested reviewer or new commits landed after my verdict", () => {
    expect(triage(pr({ ...theirs, requestedReviewers: [ME] }), ME).column).toBe("reviewRequested");
    const reviewed = (state: string): PullRequest =>
      pr({
        ...theirs,
        reviews: [{ author: ME, state, submittedAt: "2026-10-01T09:00:00Z" }],
        lastCommitAt: "2026-10-02T09:00:00Z",
      });
    expect(triage(reviewed("APPROVED"), ME).column).toBe("reviewRequested");
    // A reply in a thread is a COMMENTED review: every later push must not ask me to review again.
    expect(triage(reviewed("COMMENTED"), ME).column).toBe("others");
  });

  it("is my turn when someone answers a thread I wrote in, even one I did not start", () => {
    const t = triage(
      pr({
        ...theirs,
        threads: [
          {
            isResolved: false,
            firstAuthor: "caio",
            lastIsBot: false,
            lastAuthor: "caio",
            lastAt: "2026-10-02T09:00:00Z",
            participants: ["caio", ME],
          },
        ],
      }),
      ME,
    );
    expect(t).toMatchObject({ column: "myTurn", kind: "reply" });
  });

  it("is a review request when my team was asked", () => {
    expect(triage(pr({ ...theirs, viewerRequested: true, requestedTeams: ["web"] }), ME)).toMatchObject({
      column: "reviewRequested",
      viaTeam: true,
      reason: "pediu review do seu time",
    });
  });

  it("falls back to others", () => {
    expect(triage(pr(theirs), ME).column).toBe("others");
  });
});

describe("board", () => {
  it("puts the longest wait first where the ball is with me", () => {
    const older = pr({ id: "a", ciState: "FAILURE", lastCommitAt: "2026-09-01T00:00:00Z" });
    const newer = pr({ id: "b", ciState: "FAILURE", lastCommitAt: "2026-10-01T00:00:00Z" });
    expect(board([newer, older], ME).myTurn.map((p): string => p.pr.id)).toEqual(["a", "b"]);
  });

  it("puts the most recent activity first elsewhere", () => {
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
