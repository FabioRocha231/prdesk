import { describe, expect, it } from "vitest";

import { numberHunk } from "./diff";

describe("numberHunk", () => {
  it("numbers context, added and removed lines from the header", () => {
    const lines = numberHunk("@@ -10,3 +12,3 @@ fn\n a\n-b\n+c\n d");
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["meta", null, null, "@@ -10,3 +12,3 @@ fn"],
      ["ctx", 10, 12, "a"],
      ["del", 11, null, "b"],
      ["add", null, 13, "c"],
      ["ctx", 12, 14, "d"],
    ]);
  });

  it("accepts headers without counts", () => {
    expect(numberHunk("@@ -1 +1 @@\n+x")[1]).toMatchObject({ kind: "add", newNo: 1 });
  });
});

describe("no-newline marker", () => {
  it("does not shift line numbers", () => {
    const lines = numberHunk("@@ -1,1 +1,2 @@\n-a\n\\ No newline at end of file\n+a\n+b");
    expect(lines.filter((l) => l.kind === "add").map((l) => l.newNo)).toEqual([1, 2]);
  });
});
