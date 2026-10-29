import { describe, expect, it } from "vitest";

import { cleanLog } from "./Checks";

describe("cleanLog", () => {
  it("drops GitHub's timestamps and terminal colours", () => {
    const raw = "2026-10-28T19:35:41.1234567Z \x1b[31mError\x1b[0m: boom\n2026-10-28T19:35:42.0000000Z done";
    expect(cleanLog(raw)).toBe("Error: boom\ndone");
  });
});
