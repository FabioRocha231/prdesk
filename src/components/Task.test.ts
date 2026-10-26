import { describe, expect, it } from "vitest";

import { branchFor } from "./Task";

describe("branchFor", () => {
  it("slugs the task into a short branch name", () => {
    expect(branchFor("Adicionar retry com backoff no envio de webhooks!")).toBe(
      "prdesk/adicionar-retry-com-backoff-no-envio",
    );
    expect(branchFor("  ")).toBe("prdesk/task");
  });
});
