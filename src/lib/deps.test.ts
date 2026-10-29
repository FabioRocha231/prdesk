import { describe, expect, it } from "vitest";

import { chains, dependencyIndex, isBlocked, issueLink, parseDependencies, pullLink } from "./deps";
import type { PullRequest } from "./model";

describe("parseDependencies", () => {
  it("reads blocking lines in English and Portuguese", () => {
    const body = [
      "## O que muda",
      "Depende de ggCheckout/ggcheckout-core#605 para ser mergeado.",
      "Blocked by https://github.com/ggCheckout/ggcheckout-payments/pull/421",
      "Requires #12",
      "Refs ggCheckout/other#9",
    ].join("\n");
    expect(parseDependencies(body, "ggCheckout/saas-checkout")).toEqual([
      { repo: "ggCheckout/ggcheckout-core", number: 605 },
      { repo: "ggCheckout/ggcheckout-payments", number: 421 },
      { repo: "ggCheckout/saas-checkout", number: 12 },
    ]);
  });

  it("ignores plain mentions and dedupes", () => {
    expect(parseDependencies("Refs #3\nDepends on #4 and #4", "a/b")).toEqual([{ repo: "a/b", number: 4 }]);
  });
});

describe("dependencyIndex", () => {
  const pr = (id: string, repo: string, number: number, deps: PullRequest["dependsOn"] = []): PullRequest =>
    ({ id, repo, number, dependsOn: deps }) as PullRequest;

  it("links both directions and marks unresolved deps as off the board", () => {
    const core = pr("core", "g/core", 605);
    const saas = pr("saas", "g/saas", 1943, [
      { repo: "g/core", number: 605 },
      { repo: "g/payments", number: 1 },
    ]);
    const index = dependencyIndex([core, saas]);
    expect(index.get("saas")?.blockedBy.map((d) => d.pr?.id ?? null)).toEqual(["core", null]);
    expect(index.get("core")?.blocks.map((d) => d.number)).toEqual([1943]);
    expect(isBlocked(index.get("saas"))).toBe(true);
    expect(isBlocked(index.get("core"))).toBe(false);
  });
});

describe("chains", () => {
  const pr = (id: string, repo: string, number: number, deps: PullRequest["dependsOn"] = []): PullRequest =>
    ({ id, repo, number, dependsOn: deps }) as PullRequest;

  it("groups linked PRs in merge order and skips loners", () => {
    const a = pr("a", "g/core", 1);
    const b = pr("b", "g/saas", 2, [{ repo: "g/core", number: 1 }]);
    const c = pr("c", "g/core", 3, [{ repo: "g/saas", number: 2 }]);
    const loner = pr("x", "g/x", 9);
    const prs = [c, loner, b, a];
    expect(chains(prs, dependencyIndex(prs)).map((g) => g.map((step) => step.map((p) => p.id)))).toEqual([
      [["a"], ["b"], ["c"]],
    ]);
  });

  it("puts siblings waiting on the same PR in one step", () => {
    const core = pr("core", "g/core", 1);
    const saas = pr("saas", "g/saas", 2, [{ repo: "g/core", number: 1 }]);
    const admin = pr("admin", "g/admin", 3, [{ repo: "g/core", number: 1 }]);
    const prs = [core, saas, admin];
    expect(chains(prs, dependencyIndex(prs))[0]?.map((step) => step.map((p) => p.id))).toEqual([
      ["core"],
      ["saas", "admin"],
    ]);
  });

  it("survives a cycle", () => {
    const a = pr("a", "g/a", 1, [{ repo: "g/b", number: 2 }]);
    const b = pr("b", "g/b", 2, [{ repo: "g/a", number: 1 }]);
    expect(chains([a, b], dependencyIndex([a, b]))[0]?.flat()).toHaveLength(2);
  });
});

describe("pullLink", () => {
  it("finds the PR behind a link to it, its files or one of its comments", () => {
    const pr = { repo: "ggCheckout/saas-checkout", number: 1931 };
    expect(pullLink("https://github.com/ggCheckout/saas-checkout/pull/1931")).toEqual(pr);
    expect(pullLink("https://github.com/ggCheckout/saas-checkout/pull/1931/files")).toEqual(pr);
    expect(pullLink("https://github.com/ggCheckout/saas-checkout/pull/1931#discussion_r1")).toEqual(pr);
  });

  it("ignores issues, commits and other pages", () => {
    expect(pullLink("https://github.com/ggCheckout/saas-checkout/issues/12")).toBeNull();
    expect(pullLink("https://github.com/ggCheckout/saas-checkout/commit/abc123")).toBeNull();
    expect(pullLink("https://github.com/ggCheckout/saas-checkout/pull/12x")).toBeNull();
  });
});

describe("issueLink", () => {
  it("finds the issue behind a link and ignores PR links", () => {
    expect(issueLink("https://github.com/ggCheckout/gg-admin/issues/12#issuecomment-9")).toEqual({
      repo: "ggCheckout/gg-admin",
      number: 12,
    });
    expect(issueLink("https://github.com/ggCheckout/gg-admin/pull/12")).toBeNull();
  });
});
