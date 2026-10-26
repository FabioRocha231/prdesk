import { expect, it, describe as suite, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));

import type { Activity } from "./ipc";
import type { PullRequest } from "./model";
import { branchChanges, describe, excerpt, mergeFeed } from "./notify";

const activity: Activity = {
  id: "1",
  reason: "review_requested",
  repo: "ggCheckout/saas-checkout",
  number: 1943,
  title: "chore(payments): remove leftovers",
  updatedAt: "2026-10-26T15:16:00Z",
  actor: "lipedrumond",
  body: "<!-- template -->\n## O que muda\n\nFaxina do lado do **saas**.",
};

suite("excerpt", () => {
  it("drops template comments and markdown noise", () => {
    expect(excerpt(activity.body ?? "")).toBe("O que muda Faxina do lado do saas.");
  });

  it("caps long bodies", () => {
    expect(excerpt("a".repeat(500))).toHaveLength(200);
  });
});

suite("describe", () => {
  it("reads like GitHub Mobile", () => {
    expect(describe(activity)).toEqual({
      title: "@lipedrumond pediu seu review",
      body: "ggCheckout/saas-checkout #1943 · chore(payments): remove leftovers\nO que muda Faxina do lado do saas.",
    });
  });

  it("falls back when the actor is unknown", () => {
    expect(describe({ ...activity, actor: null, body: null, reason: "other" }).title).toBe("Atualizou a PR");
  });
});

suite("mergeFeed", () => {
  it("moves a thread with new activity to the top without duplicating it", () => {
    const old = { ...activity, id: "a", updatedAt: "2026-10-26T10:00:00Z" };
    const other = { ...activity, id: "b", updatedAt: "2026-10-26T11:00:00Z" };
    const bumped = { ...old, updatedAt: "2026-10-26T12:00:00Z" };
    expect(mergeFeed([other, old], [bumped]).map((a) => a.id)).toEqual(["a", "b"]);
  });
});

suite("branchChanges", () => {
  const pr = (over: Partial<PullRequest>): PullRequest =>
    ({
      id: "s",
      repo: "g/saas",
      number: 1,
      title: "Split",
      author: "me",
      branch: "ok",
      dependsOn: [],
      ...over,
    }) as PullRequest;
  const core = pr({ id: "c", repo: "g/core", number: 9, author: "carla" });
  const saas = pr({ dependsOn: [{ repo: "g/core", number: 9 }] });

  it("alerts on new conflicts, a stale base and a dependency that left", () => {
    expect(branchChanges([pr({})], [pr({ branch: "conflicts" })], "me").map((a) => a.title)).toEqual([
      "Sua PR tem conflitos",
    ]);
    expect(branchChanges([pr({})], [pr({ branch: "behind" })], "me").map((a) => a.title)).toEqual([
      "Sua PR ficou desatualizada",
    ]);
    expect(branchChanges([core, saas], [saas], "me")).toEqual([
      { title: "PR liberada para merge", body: "core#9 não está mais aberta\nsaas#1 · Split" },
    ]);
  });

  it("stays quiet for other people's PRs and unchanged state", () => {
    expect(branchChanges([core], [{ ...core, branch: "conflicts" }], "me")).toEqual([]);
    expect(branchChanges([core, saas], [core, saas], "me")).toEqual([]);
  });
});
