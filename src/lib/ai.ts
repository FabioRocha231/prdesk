import { numberHunk } from "./diff";
import type { AiReview, DraftComment, PrFile, PullRequest } from "./model";

// Context files above this are cut; the agent can still open any file in the worktree.
const MAX_CONTEXT = 1_500_000;

/** Runs the selected agent headless in the PR's worktree with `context` in `.prdesk/context.md`. */
export type AiRunner = (prompt: string, context: string) => Promise<string>;

function cap(text: string): string {
  return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT)}\n\n[truncated]` : text;
}

/** The PR's diff as markdown, one fenced block per file. */
export function diffContext(pr: PullRequest, body: string, files: PrFile[]): string {
  const parts = [`# ${pr.repo}#${pr.number}: ${pr.title}`, `Author: ${pr.author ?? "?"}`, "", "## Description", body];
  parts.push("", "## Changed files");
  for (const f of files) {
    const rename = f.previousPath === null ? "" : ` (renamed from ${f.previousPath})`;
    parts.push("", `### ${f.path} [${f.status}]${rename}`);
    parts.push(f.patch === null ? "(no patch: binary or too large)" : `\`\`\`diff\n${f.patch}\n\`\`\``);
  }
  return cap(parts.join("\n"));
}

export const REVIEW_PROMPT =
  "You are reviewing a GitHub pull request. Its description and full diff are in .prdesk/context.md; read it, and open any other file in this repository you need for context. Look for real bugs, risky changes, missing tests, duplicated logic and unclear intent; skip style nits. Answer ONLY with one JSON object, no prose around it, in this shape: " +
  '{"summary": "3 to 5 sentences: what changes and why", "risks": ["..."], "lookFirst": [{"path": "file", "why": "..."}], ' +
  '"comments": [{"path": "file", "line": 42, "body": "..."}]}. ' +
  "`line` is a line number on the NEW side of the diff (an added or unchanged line shown in the hunk). " +
  "At most 10 comments, each specific and actionable. Write summary, risks, why and comment bodies in Brazilian Portuguese.";

export const DESCRIBE_PROMPT =
  "Write a pull request title and description for the changes in .prdesk/context.md (the task and the diff). Answer ONLY with one JSON object: " +
  '{"title": "conventional-commit style title", "body": "markdown: what changes, why, how to test"}. ' +
  "Write in Brazilian Portuguese, keep the title under 72 characters.";

export const IMPROVE_PROMPT =
  "Rewrite the pull request description in .prdesk/context.md so a reviewer understands it fast: what changes, why, risks, how to test. Keep every fact from the original and the diff, invent nothing. Answer ONLY with the new markdown description, in the same language as the original.";

export const REPLY_PROMPT =
  "You are the pull request author answering a review thread. The thread, the diff around it and the PR are in .prdesk/context.md; read the code in this repository if needed. Draft a short, direct reply (no greeting) that answers the reviewer, in the language the reviewer used. Answer ONLY with the reply text, markdown allowed.";

export function replyContext(
  pr: PullRequest,
  path: string,
  line: number | null,
  hunk: string,
  comments: { author: string; text: string }[],
): string {
  return cap(
    [
      `# ${pr.repo}#${pr.number}: ${pr.title}`,
      "",
      `## Thread on ${path}${line === null ? "" : `:${line}`}`,
      "```diff",
      hunk,
      "```",
      "",
      ...comments.map((c): string => `**${c.author}:** ${c.text}`),
    ].join("\n"),
  );
}

/** First top-level JSON object in an agent's answer, tolerating code fences and chatter around it. */
export function parseJson(output: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("O agente não devolveu JSON.");
  return JSON.parse(output.slice(start, end + 1));
}

/** Plain-text answers sometimes come wrapped in a fence; unwrap it. */
export function stripFence(output: string): string {
  const text = output.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(text);
  return fenced?.[1] ?? text;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** New-side lines a review comment may target, per file (GitHub rejects lines outside the diff). */
export function commentableLines(files: PrFile[]): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  for (const f of files) {
    const set = new Set<number>();
    for (const l of numberHunk(f.patch ?? "")) if (l.newNo !== null && l.kind !== "del") set.add(l.newNo);
    lines.set(f.path, set);
  }
  return lines;
}

/** Validates the agent's review: drops anything malformed and comments on lines GitHub would reject. */
export function readReview(output: string, files: PrFile[]): { review: AiReview; comments: DraftComment[] } {
  const raw = parseJson(output) as Record<string, unknown>;
  const valid = commentableLines(files);
  const comments = list(raw.comments).flatMap((c, i): DraftComment[] => {
    const item = c as Record<string, unknown>;
    const path = str(item.path);
    const line = typeof item.line === "number" ? item.line : Number.NaN;
    const body = str(item.body).trim();
    if (body === "" || !valid.get(path)?.has(line)) return [];
    return [{ key: `ai-${i}-${path}:${line}`, path, line, side: "RIGHT", body, fromAi: true }];
  });
  return {
    review: {
      summary: str(raw.summary),
      risks: list(raw.risks).map(str).filter(Boolean),
      lookFirst: list(raw.lookFirst).flatMap((l): { path: string; why: string }[] => {
        const item = l as Record<string, unknown>;
        return str(item.path) === "" ? [] : [{ path: str(item.path), why: str(item.why) }];
      }),
    },
    comments,
  };
}

export function readDescription(output: string): { title: string; body: string } {
  const raw = parseJson(output) as Record<string, unknown>;
  const title = str(raw.title).trim();
  if (title === "") throw new Error("O agente não sugeriu um título.");
  return { title, body: str(raw.body) };
}
