import { describe, expect, it } from "vitest";

import { parseJson, readReview, stripFence } from "./ai";
import type { PrFile } from "./model";

const file: PrFile = {
  path: "src/a.ts",
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n tail",
  viewed: false,
};

describe("parseJson", () => {
  it("finds the object inside fences and chatter", () => {
    expect(parseJson('Here you go:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("fails clearly when there is no JSON", () => {
    expect(() => parseJson("sorry")).toThrow("JSON");
  });
});

describe("readReview", () => {
  it("keeps comments on new-side lines and drops the rest", () => {
    const output = JSON.stringify({
      summary: "Troca old por new.",
      risks: ["regressão", 3],
      lookFirst: [{ path: "src/a.ts", why: "núcleo" }, { why: "sem path" }],
      comments: [
        { path: "src/a.ts", line: 11, body: "Por que new?" },
        { path: "src/a.ts", line: 99, body: "fora do diff" },
        { path: "src/b.ts", line: 11, body: "arquivo errado" },
        { path: "src/a.ts", line: 10, body: "" },
      ],
    });
    const { review, comments } = readReview(output, [file]);
    expect(review).toEqual({
      summary: "Troca old por new.",
      risks: ["regressão"],
      lookFirst: [{ path: "src/a.ts", why: "núcleo" }],
    });
    expect(comments.map((c) => [c.line, c.side, c.fromAi])).toEqual([[11, "RIGHT", true]]);
  });
});

describe("stripFence", () => {
  it("unwraps a fenced answer", () => {
    expect(stripFence("```markdown\nOi\n```")).toBe("Oi");
    expect(stripFence("  Oi  ")).toBe("Oi");
  });
});
