import { describe, expect, it } from "vitest";

import type { TriagedPull } from "../lib/model";
import { blockers, previousWorkday, standupText } from "./Daily";

describe("previousWorkday", () => {
  it("goes back to Friday on Mondays", () => {
    expect(previousWorkday(new Date(2026, 10, 2, 10))).toBe("2026-10-30");
    expect(previousWorkday(new Date(2026, 9, 28, 10))).toBe("2026-10-27");
  });
});

describe("standupText", () => {
  const item = { repo: "acme/api", number: 7, title: "Fix login", url: "u", deploys: [] };
  const stuck = {
    pr: { repo: "acme/web", number: 9, title: "Cart", isDraft: false, updatedAt: "2026-10-20T10:00:00Z" },
    triage: { at: "2026-10-20T10:00:00Z" },
  } as TriagedPull;

  it("lists what moved and what is blocked", () => {
    const now = Date.parse("2026-10-28T10:00:00Z");
    const text = standupText({ merged: [item], opened: [], reviewed: [item] }, blockers([stuck], now));
    expect(text).toContain("Mergeei:\n- acme/api#7 Fix login");
    expect(text).toContain("Revisei:");
    expect(text).not.toContain("Abri:");
    expect(text).toContain("Travado esperando review:\n- acme/web#9 Cart");
  });

  it("says where a merge is deployed", () => {
    const shipped = {
      ...item,
      deploys: [
        { environment: "production", state: "SUCCESS" },
        { environment: "staging", state: "FAILURE" },
      ],
    };
    expect(standupText({ merged: [shipped], opened: [], reviewed: [] }, [])).toContain(
      "- acme/api#7 Fix login (production ✓, staging ✗)",
    );
  });

  it("says so when nothing happened", () => {
    expect(standupText({ merged: [], opened: [], reviewed: [] }, [])).toBe("Nada de PR desde o último dia útil.");
  });
});
