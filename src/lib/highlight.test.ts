import { describe, expect, it } from "vitest";

import { numberHunk } from "./diff";
import { highlightDiff, languageOf } from "./highlight";

describe("highlight", () => {
  it("picks grammars by extension and file name", () => {
    expect(languageOf("src/app/Button.tsx")?.[0]).toBe("tsx");
    expect(languageOf("infra/Dockerfile")?.[0]).toBe("docker");
    expect(languageOf("LICENSE")).toBeNull();
  });

  it("colors both sides of a diff and keeps line alignment", async () => {
    const lines = numberHunk("@@ -1,2 +1,2 @@\n const a = 1;\n-let b = 'x';\n+let b = \"y\";");
    const tokens = await highlightDiff(lines, "a.ts");
    expect(tokens).not.toBeNull();
    expect(tokens?.[0]).toBeNull();
    for (const i of [1, 2, 3]) {
      expect(tokens?.[i]?.map((t) => t.content).join("")).toBe(lines[i]?.text);
      expect(tokens?.[i]?.some((t) => t.color !== undefined)).toBe(true);
    }
  });
});
