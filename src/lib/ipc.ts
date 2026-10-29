import { invoke } from "@tauri-apps/api/core";

export type TokenSource = "keychain" | "gh";

export async function tokenStatus(): Promise<TokenSource | null> {
  const status = await invoke<{ source: TokenSource | null }>("token_status");
  return status.source;
}

export async function saveToken(token: string): Promise<void> {
  await invoke("save_token", { token });
}

export async function clearToken(): Promise<void> {
  await invoke("clear_token");
}

export async function githubGraphql<T>(apiUrl: string, query: string, variables: Record<string, unknown>): Promise<T> {
  return await invoke<T>("github_graphql", { apiUrl, query, variables });
}

export interface WorktreeRequest {
  repoUrl: string;
  owner: string;
  repo: string;
  number: number;
  headRef: string;
  isCrossRepository: boolean;
  baseRef: string;
  workspaceDir: string;
}

export async function prepareWorktree(req: WorktreeRequest): Promise<string> {
  return await invoke<string>("prepare_worktree", { req });
}

export interface BranchRequest {
  repoUrl: string;
  owner: string;
  repo: string;
  branch: string;
  workspaceDir: string;
}

/** Worktree on a new branch off the default branch, for work that has no PR yet. */
export async function prepareBranch(req: BranchRequest): Promise<string> {
  return await invoke<string>("prepare_branch", { req });
}

export type RestMethod = "GET" | "POST" | "PATCH" | "PUT";

/** REST call under /repos/; the token stays in Rust. */
export async function githubRest(apiUrl: string, method: RestMethod, path: string, body?: unknown): Promise<unknown> {
  return await invoke<unknown>("github_rest", { apiUrl, method, path, body: body ?? null });
}

/** Runs an agent headless in a worktree; `context` lands in `.prdesk/context.md`. Returns its stdout. */
export async function agentRun(
  path: string,
  workspaceDir: string,
  command: string,
  context: string | null,
): Promise<string> {
  return await invoke<string>("agent_run", { path, workspaceDir, command, context });
}

/** Writes `.prdesk/context.md` (or a mission's `plan.md`) in a worktree for the agent to read. */
export async function writeAgentContext(
  path: string,
  workspaceDir: string,
  text: string,
  file: "context.md" | "plan.md" = "context.md",
): Promise<void> {
  await invoke("write_agent_context", { path, workspaceDir, text, file });
}

export type MissionFile = "plan.md" | "mission.json";

/** Every mission's mission.json, unparsed. */
export async function missionList(workspaceDir: string): Promise<string[]> {
  return await invoke<string[]>("mission_list", { workspaceDir });
}

/** A mission file's text, empty when it does not exist yet. */
export async function missionRead(workspaceDir: string, id: string, file: MissionFile): Promise<string> {
  return await invoke<string>("mission_read", { workspaceDir, id, file });
}

export async function missionWrite(workspaceDir: string, id: string, file: MissionFile, text: string): Promise<void> {
  await invoke("mission_write", { workspaceDir, id, file, text });
}

export async function missionPlanPath(workspaceDir: string, id: string): Promise<string> {
  return await invoke<string>("mission_plan_path", { workspaceDir, id });
}

/** Saves `text` as the mission's request.md (planning) or check.md (integration check) and runs the agent at the
 * workspace root, where every part's worktree is visible. Returns what the agent printed. */
export async function missionAgent(
  workspaceDir: string,
  id: string,
  command: string,
  file: "request.md" | "check.md",
  text: string,
): Promise<string> {
  return await invoke<string>("mission_agent", { workspaceDir, id, command, file, text });
}

/** The agent's .prdesk/notes.md in a worktree; empty when it wrote none. */
export async function readAgentNotes(path: string, workspaceDir: string): Promise<string> {
  return await invoke<string>("read_agent_notes", { path, workspaceDir });
}

export async function ptySpawn(cwd: string, command: string, rows: number, cols: number): Promise<number> {
  return await invoke<number>("pty_spawn", { cwd, command, rows, cols });
}

/** Returns the base64 output printed before attaching; later output arrives as events. */
export async function ptyAttach(id: number): Promise<string> {
  return await invoke<string>("pty_attach", { id });
}

export async function ptyWrite(id: number, data: string): Promise<void> {
  await invoke("pty_write", { id, data });
}

export async function setZoom(zoom: number): Promise<void> {
  await invoke("set_zoom", { zoom });
}

export async function ptyResize(id: number, rows: number, cols: number): Promise<void> {
  await invoke("pty_resize", { id, rows, cols });
}

export async function ptyKill(id: number): Promise<void> {
  await invoke("pty_kill", { id });
}

export async function rerunFailedJobs(apiUrl: string, owner: string, repo: string, runId: number): Promise<void> {
  await invoke("rerun_failed_jobs", { apiUrl, owner, repo, runId });
}

/** The failed job's log tail, to read in the app. */
export async function ciLog(apiUrl: string, owner: string, repo: string, jobId: number): Promise<string> {
  return await invoke<string>("ci_log", { apiUrl, owner, repo, jobId });
}

/** Saves the failed job's log tail inside the workspace and returns its path. */
export async function saveCiLog(
  apiUrl: string,
  owner: string,
  repo: string,
  jobId: number,
  workspaceDir: string,
): Promise<string> {
  return await invoke<string>("save_ci_log", { apiUrl, owner, repo, jobId, workspaceDir });
}

export interface Changes {
  files: string[];
  diff: string;
  truncated: boolean;
  unpushed: number | null;
}

export async function worktreeChanges(path: string, workspaceDir: string): Promise<Changes> {
  return await invoke<Changes>("worktree_changes", { path, workspaceDir });
}

/** A per-PR worktree in the workspace and whether removing it would lose work. */
export interface PrWorktree {
  owner: string;
  repo: string;
  number: number;
  path: string;
  dirty: boolean;
  unpushed: boolean;
}

export async function prWorktrees(workspaceDir: string): Promise<PrWorktree[]> {
  return await invoke<PrWorktree[]>("pr_worktrees", { workspaceDir });
}

/** Removes a clean, pushed worktree; Rust refuses one with local work. */
export async function removeWorktree(path: string, workspaceDir: string): Promise<void> {
  await invoke("remove_worktree", { path, workspaceDir });
}

/** Commits everything (when dirty) and pushes; returns the short HEAD sha. */
export async function commitAndPush(
  path: string,
  workspaceDir: string,
  message: string,
  repoUrl: string,
): Promise<string> {
  return await invoke<string>("commit_and_push", { path, workspaceDir, message, repoUrl });
}

export interface Activity {
  id: string;
  reason: string;
  repo: string;
  number: number | null;
  title: string;
  updatedAt: string;
  actor: string | null;
  body: string | null;
  /** Database id of the comment or review it points at, to scroll the PR to it. */
  commentId: number | null;
}

export interface Inbox {
  items: Activity[];
  lastModified: string | null;
  pollSeconds: number;
}

/** Pull-request notifications updated after `since`; pass the previous `lastModified` to make idle polls free. */
export async function githubNotifications(apiUrl: string, since: string, lastModified: string | null): Promise<Inbox> {
  return await invoke<Inbox>("github_notifications", { apiUrl, since, lastModified });
}

/** Tauri rejects with the Rust `Err(String)`; anything else is unexpected. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Erro inesperado.";
}

export interface GraphCommit {
  hash: string;
  parents: string[];
  /** Decorations as git prints them: "HEAD -> main", "origin/main", "tag: v1.2". */
  refs: string[];
  subject: string;
  author: string;
  /** Unix seconds. */
  time: number;
}

export interface Graph {
  /** origin's URL, when the repo has one. */
  remote: string | null;
  commits: GraphCommit[];
}

export interface RepoEntry {
  path: string;
  /** Path relative to the picked folder ("saas-checkout", "services/core"). */
  name: string;
  remote: string | null;
}

/** The picked folder when it is a repo, else every repo up to two levels inside it. */
export async function gitRepos(path: string): Promise<RepoEntry[]> {
  return await invoke<RepoEntry[]>("git_repos", { path });
}

/** Branches, remote branches and tags of a local repository the user picked. */
export async function gitGraph(path: string, limit: number): Promise<Graph> {
  return await invoke<Graph>("git_graph", { path, limit });
}

export async function gitFetch(path: string): Promise<void> {
  await invoke("git_fetch", { path });
}

export interface PrGraphRequest {
  repoUrl: string;
  owner: string;
  repo: string;
  number: number;
  baseRef: string;
  /** Head branches of related PRs in the same repo. */
  branches: string[];
  workspaceDir: string;
  limit: number;
}

/** A PR against its base (and related branches), from the workspace clone; the head shows as origin/pr/<n>. */
export async function prGraph(req: PrGraphRequest): Promise<Graph> {
  return await invoke<Graph>("pr_graph", { req });
}
