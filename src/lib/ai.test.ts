import { describe, expect, it } from "vitest";

import { diffContext, parseJson, REVIEW_PROMPT, readReview, reviewPrompt, stripFence } from "./ai";
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

describe("diffContext", () => {
  it("lists what reviewers already said before the diff", () => {
    const pr = { repo: "acme/api", number: 7, title: "Retry", author: "you" } as Parameters<typeof diffContext>[0];
    const text = diffContext(
      pr,
      "body",
      [file],
      [
        { author: "maria", where: "src/a.ts:11", resolved: true, text: "Por que new?" },
        { author: "joao", where: null, resolved: false, text: "Falta teste." },
      ],
    );
    expect(text).toContain("**maria** on src/a.ts:11 (resolved):\nPor que new?");
    expect(text).toContain("**joao** on conversation:\nFalta teste.");
    expect(text.indexOf("Already said")).toBeLessThan(text.indexOf("## Changed files"));
  });
});

describe("reviewPrompt", () => {
  it("uses the app's prompt without a command and the agent's command when set", () => {
    expect(reviewPrompt(" ")).toBe(REVIEW_PROMPT);
    const custom = reviewPrompt("/review-fabio-1");
    expect(custom.startsWith("/review-fabio-1 the pull request")).toBe(true);
    expect(custom).toContain("Already said by reviewers");
    expect(custom).toContain('"comments"');
  });
});
