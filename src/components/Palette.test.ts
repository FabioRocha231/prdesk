import { describe, expect, it } from "vitest";

import type { TriagedPull } from "../lib/model";
import { matches } from "./Palette";

const item = { pr: { repo: "acme/api", number: 142, title: "Refresh expired OAuth tokens" } } as unknown as TriagedPull;

describe("palette matching", () => {
  it("needs every word, in any order and case", () => {
    expect(matches(item, "oauth api")).toBe(true);
    expect(matches(item, "#142")).toBe(true);
    expect(matches(item, "oauth web")).toBe(false);
  });
});
