/** One repo's slice of a mission, as the plan describes it. */
export interface PlanPart {
  repo: string;
  /** Repos that must merge before this one ("Depende de: acme/api"). */
  dependsOn: string[];
  body: string;
}

export interface Plan {
  title: string;
  contract: string;
  parts: PlanPart[];
}

/** The last integration check of a mission, kept in memory. */
export type MissionCheck =
  | { status: "running" }
  | { status: "done"; text: string }
  | { status: "error"; message: string };

export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string };

/** A part once the app has a worktree for it; the part itself runs as a Task with `taskId`. */
export interface MissionPart {
  repo: string;
  repoUrl: string;
  branch: string;
  taskId: string;
  cwd: string | null;
  /** The PR this part became; from then on the part lives on the board. */
  pr?: number;
}

/** Saved as mission.json; the plan itself lives in plan.md next to it. */
export interface Mission {
  id: string;
  title: string;
  request: string;
  createdAt: string;
  /** preparing worktrees → planning agent → plan to review → agents working → PRs open → every PR merged or closed. */
  phase: "preparing" | "planning" | "ready" | "running" | "delivered" | "done";
  parts: MissionPart[];
  /** planHash of the plan last copied into the worktrees, to tell when an edit was not propagated yet. */
  propagated?: string;
  /** planHash of each part's notes.md when the plan was last propagated: older contract requests count as handled. */
  seenNotes?: Record<string, string>;
  /** The last preparing or planning failure, shown until the next try. */
  error?: string;
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const CONTRACT = /^(contrato|contract)$/i;
const DEPENDS = /^(depende de|depends on)\s*:\s*(.*)$/i;
const SLUG_WORDS = 6;

/** "Mostrar o número do pedido" → "mostrar-o-numero-do-pedido". */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, SLUG_WORDS)
    .join("-");
}

/** "2026-10-27-mostrar-o-numero-do-pedido": sortable, readable on disk, and a valid folder name for Rust. */
export function missionId(title: string, now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${day}-${slugify(title) || "missao"}`;
}

/**
 * Reads plan.md. Only `## Contrato` and `## owner/repo` headings split sections; any other `##` heading stays inside
 * the section above it, so free-form notes never make a part lose text.
 */
export function parsePlan(text: string): PlanResult {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let title = "";
  let contract: string[] | null = null;
  const parts: { repo: string; lines: string[] }[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1 !== null && title === "" && current === null) {
      title = h1[1] ?? "";
      continue;
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line)?.[1];
    if (h2 !== undefined && CONTRACT.test(h2)) {
      if (contract !== null) return { ok: false, error: "O plano tem mais de uma seção ## Contrato." };
      contract = [];
      current = contract;
      continue;
    }
    if (h2 !== undefined && REPO.test(h2)) {
      if (parts.some((p): boolean => p.repo === h2)) return { ok: false, error: `O repo ${h2} aparece duas vezes.` };
      const part = { repo: h2, lines: [] as string[] };
      parts.push(part);
      current = part.lines;
      continue;
    }
    current?.push(line);
  }
  if (contract === null) return { ok: false, error: "Falta a seção ## Contrato (pode ficar vazia)." };
  const contractText = contract.join("\n").trim();
  if (parts.length === 0) return { ok: false, error: "O plano não tem nenhuma seção ## dono/repo." };

  const repos = new Set(parts.map((p): string => p.repo));
  const out: PlanPart[] = [];
  for (const p of parts) {
    const firstAt = p.lines.findIndex((l): boolean => l.trim() !== "");
    const dep = firstAt === -1 ? null : DEPENDS.exec((p.lines[firstAt] ?? "").trim());
    const dependsOn =
      dep === null
        ? []
        : (dep[2] ?? "")
            .split(",")
            .map((r): string => r.trim())
            .filter(Boolean);
    for (const d of dependsOn) {
      if (d === p.repo) return { ok: false, error: `${p.repo} depende dele mesmo.` };
      if (!repos.has(d)) return { ok: false, error: `${p.repo} depende de ${d}, que não está no plano.` };
    }
    const body = dep === null ? p.lines : p.lines.filter((_, i): boolean => i !== firstAt);
    out.push({ repo: p.repo, dependsOn, body: body.join("\n").trim() });
  }
  if (mergeOrder(out) === null) return { ok: false, error: "As dependências entre os repos formam um ciclo." };
  return { ok: true, plan: { title, contract: contractText, parts: out } };
}

/** Parts in an order where every dependency comes first (Kahn); null when the dependencies form a cycle. */
export function mergeOrder(parts: PlanPart[]): PlanPart[] | null {
  const done = new Set<string>();
  const order: PlanPart[] = [];
  let left = [...parts];
  while (left.length > 0) {
    const ready = left.filter((p): boolean => p.dependsOn.every((d): boolean => done.has(d)));
    if (ready.length === 0) return null;
    for (const p of ready) {
      done.add(p.repo);
      order.push(p);
    }
    left = left.filter((p): boolean => !done.has(p.repo));
  }
  return order;
}

/** djb2 over the text: enough to notice that a small local file changed, not a security hash. */
export function planHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(16)}`;
}

/** The latest `## CONTRACT CHANGE` request in an agent's notes.md, or null when it asked for none. */
export function contractChange(notes: string): string | null {
  const sections = notes.replace(/\r\n/g, "\n").split(/^##\s+/m);
  const last = sections.filter((s): boolean => /^contract change\s*\n/i.test(s)).at(-1);
  return last === undefined ? null : last.replace(/^contract change\s*\n/i, "").trim();
}

/** Typed into every running part's terminal after the plan changed. */
export const PROPAGATE_MESSAGE =
  "O plano da missão mudou: releia .prdesk/plan.md, ajuste o que for preciso e me diga o que mudou.";

/** A part's PR description: its own text, where it sits in the mission, and the PRs it must merge after. */
export function prBody(body: string, missionTitle: string, after: { repo: string; number: number }[]): string {
  const deps = after.map((d): string => `Depende de ${d.repo}#${d.number}`);
  return [body.trim(), "", "---", `Parte da missão **${missionTitle}**.`, ...deps].join("\n").trim();
}

/** check.md for the integration pass: the contract and every part's diff, side by side. */
export function checkRequest(contract: string, diffs: { repo: string; diff: string }[]): string {
  return [
    "# Contract",
    "",
    contract === "" ? "(empty)" : contract,
    "",
    ...diffs.flatMap((d): string[] => [`# Diff of ${d.repo}`, "", "```diff", d.diff, "```", ""]),
    "# What to answer",
    "",
    "Check that the diffs above honour the contract and agree with each other: field names and types, endpoints, events, env vars, migration order. List every mismatch as a markdown bullet naming the repository and the file. If everything matches, say so in one line. Answer ONLY with that list, in Brazilian Portuguese.",
  ].join("\n");
}

export function checkPrompt(id: string): string {
  return `Read missions/${id}/check.md in this folder and follow it. Answer ONLY with what it asks for.`;
}

/** request.md for the planning agent: what to do, where each repo is checked out, and the plan's exact shape. */
export function planRequest(request: string, worktrees: { repo: string; path: string }[]): string {
  return [
    "# Request",
    "",
    request,
    "",
    "# Repositories",
    "",
    "Each one is checked out on a fresh branch; read whatever code you need to plan well.",
    "",
    ...worktrees.map((w): string => `- ${w.repo}: ${w.path}`),
    "",
    "# What to answer",
    "",
    "Plan this change across the repositories above. Answer ONLY with the plan in markdown, nothing around it, in exactly this shape:",
    "",
    "- First line: `# <short title of the change>`.",
    "- A section `## Contrato` listing everything the repositories must agree on: endpoints, payload fields with their types, event names, env vars, migrations order. Leave it empty only if they share nothing.",
    "- One section per repository, titled exactly `## owner/repo` as listed above. When it can only merge after another one, its first line is `Depende de: owner/repo`. Then what to change there, concretely enough for an agent working only in that repository.",
    "",
    "Write the plan in Brazilian Portuguese.",
  ].join("\n");
}

export function planPrompt(id: string): string {
  return `Read missions/${id}/request.md in this folder and follow it. Answer ONLY with the plan markdown it asks for.`;
}

/** The interactive prompt for one part's agent; its details go to .prdesk/context.md. */
export function partTask(title: string, repo: string, count: number): string {
  return `You are one of ${count} agents working on the mission "${title}", each in its own repository. Yours is ${repo}.`;
}

export function partContext(part: PlanPart): string {
  return [
    `# Your part: ${part.repo}`,
    "",
    part.body,
    "",
    "# Rules",
    "",
    "- The whole plan is in .prdesk/plan.md. Its `## Contrato` section binds every repository: honour it exactly.",
    "- If the contract cannot work, do not change it on your own: append a section `## CONTRACT CHANGE` with what must change and why to .prdesk/notes.md, then stop and wait for me.",
    "- Follow the repository's conventions, add or update tests, and run them.",
    "- Do not commit or push: I review the diff and open the PR from prdesk.",
  ].join("\n");
}

/** The plan's skeleton, written before the planning agent runs (or instead of it, when no agent can run headless). */
export function planTemplate(title: string, repos: string[]): string {
  return [`# ${title}`, "", "## Contrato", "", ...repos.flatMap((r): string[] => [`## ${r}`, "", ""])].join("\n");
}
