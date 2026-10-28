import { load } from "@tauri-apps/plugin-store";

import type { PullRequest } from "./model";

export interface Agent {
  id: string;
  name: string;
  /** Shell command; `{prompt}` is replaced by the single-quoted prompt. */
  command: string;
  /** Non-interactive variant that prints its answer and exits (AI review, drafted replies). Empty disables it. */
  headless: string;
  /** Review command for "Analisar", e.g. `/review-fabio-1`; empty uses the app's own review prompt. */
  reviewCommand: string;
  /** Orgs (`acme`) or repos (`acme/api`) this agent is used for, e.g. one Claude account per client. */
  repos: string[];
}

export interface Config {
  apiUrl: string;
  /** `org` or `owner/repo`, one per entry. */
  scopes: string[];
  /** Empty means ~/PRDesk. */
  workspaceDir: string;
  agents: Agent[];
  defaultAgentId: string;
  pollSeconds: number;
  /** Interface scale, 1 is 100%; for big monitors. */
  zoom: number;
}

export const MIN_ZOOM = 0.8;
export const MAX_ZOOM = 2;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 10) / 10));
}

export const DEFAULT_CONFIG: Config = {
  apiUrl: "https://api.github.com/graphql",
  scopes: [],
  workspaceDir: "",
  agents: [
    {
      id: "claude",
      name: "Claude Code",
      command: "claude {prompt}",
      headless: "claude -p {prompt}",
      reviewCommand: "",
      repos: [],
    },
    {
      id: "codex",
      name: "Codex",
      command: "codex {prompt}",
      headless: "codex exec --skip-git-repo-check -s read-only {prompt}",
      reviewCommand: "",
      repos: [],
    },
    {
      id: "opencode",
      name: "OpenCode",
      command: "opencode --prompt {prompt}",
      headless: "opencode run {prompt}",
      reviewCommand: "",
      repos: [],
    },
  ],
  defaultAgentId: "claude",
  pollSeconds: 60,
  zoom: 1,
};

const STORE_FILE = "settings.json";
const KEY = "config";
const MIN_POLL_SECONDS = 30;
const SCOPE_PATTERN = /^[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/;

export function isValidScope(scope: string): boolean {
  return SCOPE_PATTERN.test(scope);
}

/** Merges a stored config onto the defaults so new fields survive upgrades. */
function normalize(stored: Partial<Config> | undefined): Config {
  const config = { ...DEFAULT_CONFIG, ...stored };
  return {
    ...config,
    scopes: config.scopes.filter(isValidScope),
    pollSeconds: Math.max(MIN_POLL_SECONDS, config.pollSeconds),
    zoom: clampZoom(config.zoom),
    // Agents saved before `headless` existed get the default for their id.
    agents: (config.agents.length > 0 ? config.agents : DEFAULT_CONFIG.agents).map(
      (a): Agent => ({
        ...a,
        headless: a.headless ?? DEFAULT_CONFIG.agents.find((d): boolean => d.id === a.id)?.headless ?? "",
        reviewCommand: a.reviewCommand ?? "",
        repos: (a.repos ?? []).filter(isValidScope),
      }),
    ),
  };
}

export async function loadConfig(): Promise<Config> {
  const store = await load(STORE_FILE);
  return normalize(await store.get<Partial<Config>>(KEY));
}

export async function saveConfig(config: Config): Promise<Config> {
  const clean = normalize(config);
  const store = await load(STORE_FILE);
  await store.set(KEY, clean);
  await store.save();
  return clean;
}

// PowerShell also treats the curly quotes as quote characters.
const QUOTES = /['\u2018\u2019\u201A\u201B]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are exactly what must not reach the PTY
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * Single-quotes text for POSIX shells and PowerShell. Prompts can carry review comments written by other people,
 * so quotes and control bytes (which a PTY would act on) are dropped rather than escaped.
 */
export function shellQuote(text: string): string {
  return `'${text.replace(CONTROL, " ").replace(QUOTES, "")}'`;
}

export function agentPrompt(pr: PullRequest, me: string): string {
  if (pr.author === me) {
    return `Read the unresolved review threads and comments on pull request ${pr.url} (gh pr view ${pr.number} --comments, or the GitHub API) and address each one in this worktree. Summarize what you changed per thread.`;
  }
  return `Review pull request ${pr.url}: read its description and diff (gh pr diff ${pr.number}), then report bugs, risks and suggestions ordered by severity.`;
}

// ponytail: prompts are flattened to one line so they survive being typed into any shell; the agent re-reads files itself.
const MAX_PROMPT = 3000;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_PROMPT ? `${flat.slice(0, MAX_PROMPT - 1)}…` : flat;
}

export function threadPrompt(
  pr: PullRequest,
  path: string,
  line: number | null,
  comments: { author: string; text: string }[],
): string {
  const where = line === null ? path : `${path}:${line}`;
  const talk = comments.map((c): string => `${c.author}: ${c.text}`).join(" | ");
  return oneLine(
    `Address this review thread on pull request ${pr.url}, about ${where}. Conversation: ${talk}. Make the change in this worktree and summarize what you did.`,
  );
}

export function ciPrompt(pr: PullRequest, checkName: string, logPath: string): string {
  return oneLine(
    `The CI check "${checkName}" failed on pull request ${pr.url}. The tail of its log is in ${logPath}. Read it, find the root cause, fix it in this worktree and run the relevant tests locally.`,
  );
}

/** The agent for a repo: the one picked by hand, then one listing the repo, then one listing its owner, then the default. */
export function agentFor(config: Config, repo: string, pickedId?: string): Agent | undefined {
  const owner = repo.split("/")[0];
  const byId = (id: string | undefined): Agent | undefined => config.agents.find((a): boolean => a.id === id);
  return (
    byId(pickedId) ??
    config.agents.find((a): boolean => a.repos.includes(repo)) ??
    config.agents.find((a): boolean => owner !== undefined && a.repos.includes(owner)) ??
    byId(config.defaultAgentId) ??
    config.agents[0]
  );
}

export function agentCommand(agent: Agent, prompt: string): string {
  return agent.command.replaceAll("{prompt}", shellQuote(prompt));
}

export function headlessCommand(agent: Agent, prompt: string): string {
  return agent.headless.replaceAll("{prompt}", shellQuote(prompt));
}

/** For bigger jobs the details go to `.prdesk/context.md` and the prompt only points there. */
export function contextPrompt(task: string): string {
  return oneLine(`${task} The full details are in .prdesk/context.md in this worktree; read it first.`);
}
