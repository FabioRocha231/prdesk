import { describe, expect, it } from "vitest";

import { latestDeploys, type RawRepoRadar, readRadar } from "./github";

const NOW = Date.parse("2026-10-27T12:00:00Z");

const ref = (name: string, login: string, at: string, prs = 0): RawRepoRadar["refs"]["nodes"][number] => ({
  name,
  associatedPullRequests: { totalCount: prs },
  target: { committedDate: at, messageHeadline: `work on ${name}`, author: { user: { login } } },
});

const repo = (state: string, refs: RawRepoRadar["refs"]["nodes"]): RawRepoRadar => ({
  nameWithOwner: "acme/web",
  defaultBranchRef: {
    name: "main",
    target: { url: "https://github.com/acme/web/commit/abc", statusCheckRollup: { state } },
  },
  refs: { nodes: refs },
});

describe("readRadar", () => {
  it("keeps only my recent branches without a PR, newest first", () => {
    const radar = readRadar(
      [
        repo("SUCCESS", [
          ref("main", "you", "2026-10-27T10:00:00Z"),
          ref("old", "you", "2026-09-01T10:00:00Z"),
          ref("has-pr", "you", "2026-10-26T10:00:00Z", 1),
          ref("theirs", "maria", "2026-10-26T10:00:00Z"),
          ref("a", "you", "2026-10-25T10:00:00Z"),
          ref("b", "you", "2026-10-26T10:00:00Z"),
        ]),
        null,
      ],
      "you",
      NOW,
    );
    expect(radar.branches.map((b) => b.branch)).toEqual(["b", "a"]);
    expect(radar.broken).toEqual([]);
  });

  it("flags a red default branch", () => {
    expect(readRadar([repo("FAILURE", [])], "you", NOW).broken).toEqual([
      { repo: "acme/web", branch: "main", url: "https://github.com/acme/web/commit/abc" },
    ]);
  });
});

describe("latestDeploys", () => {
  it("keeps the newest deploy per environment", () => {
    expect(
      latestDeploys({
        nodes: [
          { environment: "production", latestStatus: { state: "IN_PROGRESS" } },
          { environment: "production", latestStatus: { state: "SUCCESS" } },
          { environment: null, latestStatus: null },
          { environment: "staging", latestStatus: null },
        ],
      }),
    ).toEqual([
      { environment: "production", state: "IN_PROGRESS" },
      { environment: "staging", state: "PENDING" },
    ]);
  });
});
