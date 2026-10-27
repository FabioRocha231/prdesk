import { describe, expect, it } from "vitest";

import { contractChange, mergeOrder, missionId, parsePlan, planHash, prBody, slugify } from "./mission";

const PLAN = `# Número do pedido no recibo

## Contrato

- \`orderNumber: string\` em GET /orders/:id

## acme/api

Serializer e migração.

## Notas soltas
ficam dentro da parte acima

## acme/web
Depende de: acme/api

Mostrar no recibo.
`;

describe("parsePlan", () => {
  it("reads the title, the contract, parts and their dependencies", () => {
    const result = parsePlan(PLAN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.title).toBe("Número do pedido no recibo");
    expect(result.plan.contract).toBe("- `orderNumber: string` em GET /orders/:id");
    expect(result.plan.parts.map((p) => [p.repo, p.dependsOn])).toEqual([
      ["acme/api", []],
      ["acme/web", ["acme/api"]],
    ]);
    expect(result.plan.parts[0]?.body).toContain("ficam dentro da parte acima");
    expect(result.plan.parts[1]?.body).toBe("Mostrar no recibo.");
  });

  it("refuses plans the app cannot launch", () => {
    expect(parsePlan("## acme/api\nx").ok).toBe(false);
    expect(parsePlan("## Contrato\n").ok).toBe(false);
    expect(parsePlan("## Contract\n## acme/api\n## acme/api\n").ok).toBe(false);
    expect(parsePlan("## Contrato\n## acme/web\nDepende de: acme/api\n").ok).toBe(false);
    expect(parsePlan("## Contrato\n## acme/web\nDepends on: acme/web\n").ok).toBe(false);
  });
});

describe("ids", () => {
  it("slugs titles and prefixes the day", () => {
    expect(slugify("Mostrar o número do pedido no recibo agora já")).toBe("mostrar-o-numero-do-pedido-no");
    expect(missionId("Número do pedido", new Date(2026, 9, 27))).toBe("2026-10-27-numero-do-pedido");
    expect(missionId("!!!", new Date(2026, 9, 27))).toBe("2026-10-27-missao");
  });
});

describe("mergeOrder", () => {
  const part = (repo: string, dependsOn: string[] = []) => ({ repo, dependsOn, body: "" });

  it("puts dependencies first and refuses cycles", () => {
    expect(mergeOrder([part("a/web", ["a/api"]), part("a/api"), part("a/app", ["a/web"])])?.map((p) => p.repo)).toEqual(
      ["a/api", "a/web", "a/app"],
    );
    expect(mergeOrder([part("a/x", ["a/y"]), part("a/y", ["a/x"])])).toBeNull();
    expect(parsePlan("## Contrato\n## a/x\nDepende de: a/y\n## a/y\nDepende de: a/x\n").ok).toBe(false);
  });
});

describe("contractChange", () => {
  it("finds the latest request and ignores other notes", () => {
    expect(contractChange("Feito o serializer.\n")).toBeNull();
    expect(
      contractChange(
        "## Progresso\nok\n## CONTRACT CHANGE\nprimeiro\n## Contract change\nnumber, não string\n## Depois\nx",
      ),
    ).toBe("number, não string");
  });
});

describe("planHash and prBody", () => {
  it("changes with the text and links the PRs to merge first", () => {
    expect(planHash("a")).not.toBe(planHash("b"));
    expect(planHash("a")).toBe(planHash("a"));
    expect(prBody("Mostra o número.", "Recibo", [{ repo: "acme/api", number: 12 }])).toBe(
      "Mostra o número.\n\n---\nParte da missão **Recibo**.\nDepende de acme/api#12",
    );
  });
});
