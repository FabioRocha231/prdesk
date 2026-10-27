import { describe, expect, it } from "vitest";

import { applySuggestion, fromBase64, parseSuggestion, toBase64 } from "./suggestion";

describe("parseSuggestion", () => {
  it("reads the block, an empty one (delete) and none", () => {
    expect(parseSuggestion("Try:\r\n```suggestion\r\nconst a = 1;\r\n```\r\n")).toBe("const a = 1;");
    expect(parseSuggestion("```suggestion\n```")).toBe("");
    expect(parseSuggestion("```ts\nconst a = 1;\n```")).toBeNull();
  });
});

describe("applySuggestion", () => {
  it("replaces a range and keeps CRLF and the trailing newline", () => {
    expect(applySuggestion("a\r\nb\r\nc\r\n", 2, 3, "x\ny")).toBe("a\r\nx\r\ny\r\n");
    expect(applySuggestion("a\nb\nc", 2, 2, "")).toBe("a\nc");
  });

  it("refuses lines past the end", () => {
    expect(() => applySuggestion("a\nb", 2, 5, "x")).toThrow();
  });
});

describe("base64", () => {
  it("round-trips UTF-8", () => {
    expect(fromBase64(toBase64("ação ✓"))).toBe("ação ✓");
  });
});
