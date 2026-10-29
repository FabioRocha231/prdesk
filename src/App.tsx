import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  Bell,
  CalendarCheck,
  CircleDot,
  CircleHelp,
  Clock,
  Columns3,
  GitGraph,
  GitPullRequest,
  GitPullRequestCreate,
  Link2,
  List as ListIcon,
  RefreshCw,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Terminal as TerminalIcon,
  Workflow,
  X,
} from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { type AgentState, Board } from "./components/Board";
import { Chains } from "./components/Chains";
import { DailyDialog } from "./components/Daily";
import { Detail, type DetailState, type PrAi, type SnoozeChoice } from "./components/Detail";
import { Feed } from "./components/Feed";
import { TreeView } from "./components/GitTree";
import { HelpDialog } from "./components/Help";
import { IssuesDialog } from "./components/Issues";
import { MissionsView, NewMissionDialog, type PartStatus } from "./components/Mission";
import { Palette } from "./components/Palette";
import { PrList } from "./components/PrList";
import { BaseChecksDialog, BranchPrDialog, RadarStrip } from "./components/Radar";
import { RepoFilter } from "./components/RepoFilter";
import type { AiState } from "./components/Review";
import { Settings } from "./components/Settings";
import { branchFor, NewTaskDialog, type Task, type TaskSeed, TaskView } from "./components/Task";
import { Terminal } from "./components/Terminal";
import { htmlToText, type ReplyDrafter } from "./components/Threads";
import { UpdateButton } from "./components/UpdateButton";
import {
  DESCRIBE_PROMPT,
  diffContext,
  REPLY_PROMPT,
  readDescription,
  readReview,
  replyContext,
  reviewPrompt,
  type Said,
  stripFence,
} from "./lib/ai";
import {
  type Agent,
  agentCommand,
  agentFor,
  agentPrompt,
  type Config,
  clampZoom,
  contextPrompt,
  headlessCommand,
  loadConfig,
  saveConfig,
} from "./lib/config";
import { chains as chainsOf, type Deps, dependencyIndex, type PrRef, refKey, shortRef } from "./lib/deps";
import { clock } from "./lib/format";
import {
  createPull,
  fetchDetail,
  fetchIssues,
  fetchPull,
  fetchPulls,
  fetchRadar,
  type Issue,
  markReady,
  type PullCache,
  pullsFromCache,
  type Radar,
  requestReviewers,
  type BrokenBase,
  type StrayBranch,
} from "./lib/github";
import { holderGroups } from "./lib/holders";
import {
  type Activity,
  agentRun,
  type Changes,
  commitAndPush,
  errorMessage,
  githubNotifications,
  missionAgent,
  missionList,
  missionPlanPath,
  missionRead,
  missionWrite,
  prepareBranch,
  prepareWorktree,
  ptyKill,
  ptySpawn,
  ptyWrite,
  readAgentNotes,
  setZoom,
  tokenStatus,
  worktreeChanges,
  writeAgentContext,
} from "./lib/ipc";
import {
  checkPrompt,
  checkRequest,
  contractChange,
  type Mission,
  type MissionCheck,
  type MissionPart,
  mergeOrder,
  missionId,
  PROPAGATE_MESSAGE,
  parsePlan,
  partContext,
  partTask,
  planHash,
  planPrompt,
  planRequest,
  planTemplate,
  prBody,
  slugify,
} from "./lib/mission";
import { COLUMNS, type DraftComment, type PrFile, type PullRequest, type TriagedPull } from "./lib/model";
import { mergeFeed, notifyActivity, notifyAgentQuiet, notifyBranchChanges, setBadge } from "./lib/notify";
import { loadCached, loadValue, saveCached, saveValue } from "./lib/persist";
import { activeFilter, reposByOrg, toggleRepo } from "./lib/repoFilter";
import { isSnoozed, type Snoozes, wakeTime } from "./lib/snooze";
import { board, triage } from "./lib/triage";

const SECOND = 1000;
const RADAR_EVERY_MS = 5 * 60 * SECOND;
const DOCK_MIN = 160;
const DOCK_MIN_ABOVE = 220;
const DOCK_STEP = 40;
// The task box holds 4000 characters; a long issue body is cut, the agent can still open the issue.
const MAX_TASK_TEXT = 4000;
const INITIAL_ROWS = 24;
const INITIAL_COLS = 80;
const HOUR = 3600 * SECOND;
const FEED_BACKFILL_HOURS = 24;
const NOTIFY_FIRST_DELAY_SECONDS = 2;
const NOTIFY_RETRY_SECONDS = 300;
const IDLE_AI: AiState = { status: "idle" };
const NO_DRAFTS: DraftComment[] = [];
const NO_DEPS: Deps = { blockedBy: [], blocks: [] };
const TASK_PREFIX = "task:";
const MAX_MISSION_TITLE = 120;
const NOTES_EVERY_MS = 30 * SECOND;

const BOARD_CACHE_KEY = "board";

type View = "board" | "settings" | "tree" | "chains" | "missions";
const VIEW_TITLE: Record<View, string> = {
  board: "Pull requests",
  settings: "Ajustes",
  tree: "Árvore",
  chains: "Encadeadas",
  missions: "Missões",
};

/** "https://api.github.com/graphql" → "github.com"; a GHE host stays as is. */
function webHost(apiUrl: string): string {
  return new URL(apiUrl).host.replace(/^api\./, "");
}

type Sync = { loading: boolean; at: Date | null; error: string | null };

type Session =
  | { status: "preparing"; agentName: string }
  /** `quiet`: no terminal output for a while, so the agent likely finished or is asking something. */
  | { status: "running"; agentName: string; sessionId: number; cwd: string; quiet?: boolean }
  | { status: "exited"; agentName: string; cwd: string }
  | { status: "error"; agentName: string; message: string };

/** Runs a state update inside a view transition when the window is visible and nothing is being dragged. */
function transition(update: () => void): void {
  // A transition snapshots and covers the page, which would cancel a column being dragged mid-sync.
  const dragging = document.querySelector(".lane-slot.is-dragging") !== null;
  if (document.hidden || dragging || typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  document.startViewTransition((): void => flushSync(update)).ready.catch((): void => {});
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("input, textarea, select, .xterm") !== null;
}

export function App(): ReactElement {
  const [config, setConfig] = useState<Config | null>(null);
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [view, setView] = useState<View>("board");
  const [missions, setMissions] = useState<Mission[]>([]);
  const [missionPlans, setMissionPlans] = useState<Record<string, string>>({});
  const [openMissionId, setOpenMissionId] = useState<string | null>(null);
  const [newMissionOpen, setNewMissionOpen] = useState(false);
  // Each part's .prdesk/notes.md by task id, and the last integration check per mission.
  const [partNotes, setPartNotes] = useState<Record<string, string>>({});
  const [missionChecks, setMissionChecks] = useState<Record<string, MissionCheck>>({});
  const [me, setMe] = useState<string | null>(null);
  const [pulls, setPulls] = useState<PullRequest[] | null>(null);
  const [sync, setSync] = useState<Sync>({ loading: false, at: null, error: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Highlighted card on the full board: j/k move it, Enter opens it.
  const [cursor, setCursor] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  // A hand-picked agent per repo, for this run of the app; otherwise agentFor routes by the agent's repos.
  const [agentPicks, setAgentPicks] = useState<Record<string, string>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [feed, setFeed] = useState<Activity[]>([]);
  // PRs opened from the feed that are not on the board (closed, merged, or outside the scopes).
  const [extra, setExtra] = useState<Record<string, PullRequest>>({});
  const [feedOpen, setFeedOpen] = useState(false);
  // The comment a picked notification points at, until its PR shows it.
  const [focus, setFocus] = useState<(PrRef & { commentId: number }) | null>(null);
  const clearFocus = useCallback((): void => setFocus(null), []);
  const [feedSeenAt, setFeedSeenAt] = useState((): number => Date.now());
  // Review drafts and AI results live here so they survive switching PRs.
  const [drafts, setDrafts] = useState<Record<string, DraftComment[]>>({});
  const [aiStates, setAiStates] = useState<Record<string, AiState>>({});
  const [worktrees, setWorktrees] = useState<Record<string, string>>({});
  const [snoozes, setSnoozes] = useState<Snoozes>({});
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [repoFilter, setRepoFilter] = useState<string[]>([]);
  const [detailed, setDetailed] = useState(false);
  // The board as one list grouped by who holds the ball (default) or as columns.
  const [boardView, setBoardView] = useState<"list" | "columns">("list");
  // Terminal dock height in px once the user resized it; null keeps the default share of the window.
  const [dockHeight, setDockHeight] = useState<number | null>(null);
  const [dockDragging, setDockDragging] = useState(false);
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [taskSeed, setTaskSeed] = useState<TaskSeed | null>(null);
  const [radar, setRadar] = useState<Radar>({ branches: [], broken: [] });
  const [stray, setStray] = useState<StrayBranch | null>(null);
  const [brokenBase, setBrokenBase] = useState<BrokenBase | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const radarAt = useRef(0);
  const [dailyOpen, setDailyOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const inFlight = useRef(false);
  const cacheRef = useRef<PullCache>({});
  // PRs the user just acted on: their details are read again even when GitHub did not bump updatedAt.
  const forceRefetch = useRef(new Set<string>());
  const refreshAgain = useRef(false);
  const meRef = useRef(me);
  meRef.current = me;

  const checkToken = useCallback(async (): Promise<void> => {
    try {
      const source = await tokenStatus();
      setHasToken(source !== null);
      if (source === null) setView("settings");
    } catch (e) {
      setHasToken(false);
      setView("settings");
      setSync((s): Sync => ({ ...s, error: errorMessage(e) }));
    }
  }, []);

  useEffect((): void => {
    void (async (): Promise<void> => {
      const loaded = await loadConfig();
      setConfig(loaded);
      setSnoozes(await loadValue<Snoozes>("snoozes", {}));
      setTasks(await loadValue<Record<string, Task>>("tasks", {}));
      setRepoFilter(await loadValue<string[]>("repoFilter", []));
      setDetailed(await loadValue<boolean>("boardDetailed", false));
      // Older versions stored "orbit", which became the list.
      setBoardView((await loadValue<string>("boardView", "list")) === "columns" ? "columns" : "list");
      setDockHeight(await loadValue<number | null>("dockHeight", null));
      // Last sync's board shows at once; the first refresh then only fetches what changed while the app was closed.
      try {
        const cached = await loadCached<{ me: string; pulls: PullCache } | null>(BOARD_CACHE_KEY, null);
        if (cached !== null) {
          cacheRef.current = cached.pulls;
          setMe(cached.me);
          setPulls(pullsFromCache(cached.pulls));
        }
      } catch {
        // Degraded: no cache (first launch, plain browser, unreadable file); the first sync fetches everything.
      }
      await checkToken();
    })();
  }, [checkToken]);

  // Branches, red bases and issues change slowly and cost a query each, so they ride along every few minutes.
  const updateRadar = useCallback(
    async (all: PullRequest[], login: string, force = false): Promise<void> => {
      if (config === null || (!force && Date.now() - radarAt.current < RADAR_EVERY_MS)) return;
      radarAt.current = Date.now();
      // Repos where I have PRs come first: that is where my other branches most likely are.
      const count = new Map<string, number>();
      for (const p of all) count.set(p.repo, (count.get(p.repo) ?? 0) + (p.author === login ? 100 : 1));
      const repos = [...count].sort((a, b): number => b[1] - a[1]).map(([repo]): string => repo);
      const [nextRadar, nextIssues] = await Promise.allSettled([fetchRadar(config, repos, login), fetchIssues(config)]);
      if (nextRadar.status === "fulfilled") setRadar(nextRadar.value);
      // Degraded: the radar strip keeps its last state; the next refresh tries again.
      else console.warn("[App.radar] fetch failed", errorMessage(nextRadar.reason));
      if (nextIssues.status === "fulfilled") {
        setIssues(nextIssues.value);
        setIssuesError(null);
      } else setIssuesError(errorMessage(nextIssues.reason));
    },
    [config],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (config === null) return;
    if (inFlight.current) {
      // That sync may have read GitHub before the change that asked for this one; run again once it lands.
      refreshAgain.current = true;
      return;
    }
    inFlight.current = true;
    setSync((s): Sync => ({ ...s, loading: true }));
    const forced = new Set(forceRefetch.current);
    try {
      const result = await fetchPulls(config, cacheRef.current, forced);
      for (const id of forced) forceRefetch.current.delete(id);
      cacheRef.current = result.cache;
      saveCached(BOARD_CACHE_KEY, { me: result.me, pulls: result.cache }).catch((): void => {
        // Degraded: the next launch just starts from an empty board.
      });
      void setBadge(board(result.pulls, result.me).myTurn.length);
      void updateRadar(result.pulls, result.me);
      if (pulls !== null) void notifyBranchChanges(pulls, result.pulls, result.me);
      const apply = (): void => {
        setMe(result.me);
        setPulls(result.pulls);
      };
      // Rows that change column glide to their new place; the first load just appears.
      if (pulls !== null) transition(apply);
      else apply();
      setSync({ loading: false, at: new Date(), error: null });
    } catch (e) {
      setSync((s): Sync => ({ ...s, loading: false, error: errorMessage(e) }));
    } finally {
      inFlight.current = false;
      if (refreshAgain.current) {
        refreshAgain.current = false;
        void refreshRef.current();
      }
    }
  }, [config, pulls, updateRadar]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect((): (() => void) | undefined => {
    if (config === null || hasToken !== true) return undefined;
    void refreshRef.current();
    const timer = window.setInterval((): void => void refreshRef.current(), config.pollSeconds * SECOND);
    const onFocus = (): void => void refreshRef.current();
    window.addEventListener("focus", onFocus);
    return (): void => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [config, hasToken]);

  // Live notifications: polls GitHub's notification feed at the interval GitHub asks for (idle polls are free 304s).
  // Anything new pops a native notification and refreshes the board right away instead of waiting for the next sync.
  useEffect((): (() => void) | undefined => {
    if (config === null || hasToken !== true) return undefined;
    // The first poll backfills the feed with the last day, already read and without popping notifications.
    let since = new Date(Date.now() - FEED_BACKFILL_HOURS * HOUR).toISOString();
    let first = true;
    let lastModified: string | null = null;
    let timer = 0;
    let stopped = false;
    const poll = async (): Promise<void> => {
      let wait = NOTIFY_RETRY_SECONDS;
      try {
        const startedAt = new Date().toISOString();
        const inbox = await githubNotifications(config.apiUrl, since, lastModified);
        since = inbox.items.length > 0 || first ? startedAt : since;
        lastModified = inbox.lastModified;
        wait = inbox.pollSeconds;
        const fresh = inbox.items.filter((a): boolean => a.actor === null || a.actor !== meRef.current);
        if (fresh.length > 0) setFeed((f): Activity[] => mergeFeed(f, fresh));
        if (!first && inbox.items.length > 0) {
          void notifyActivity(fresh, meRef.current);
          void refreshRef.current();
        }
        first = false;
      } catch (e) {
        // Degraded: fine-grained tokens cannot read notifications; the board keeps syncing on its own timer.
        console.warn("[App.notifications] poll failed", errorMessage(e));
      }
      if (!stopped) timer = window.setTimeout((): void => void poll(), wait * SECOND);
    };
    timer = window.setTimeout((): void => void poll(), NOTIFY_FIRST_DELAY_SECONDS * SECOND);
    return (): void => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [config, hasToken]);

  const now = Date.now();
  const snoozedCount = (pulls ?? []).filter((p): boolean => isSnoozed(snoozes[p.id], p, now)).length;
  const repoOrgs = useMemo(() => reposByOrg((pulls ?? []).map((p): string => p.repo)), [pulls]);
  const chipRepos = useMemo((): string[] => repoOrgs.flatMap(([, repos]): string[] => repos), [repoOrgs]);
  // A saved repo with no PRs left would empty the board for no visible reason, so it stops counting.
  const shownRepos = useMemo(() => activeFilter(repoFilter, chipRepos), [repoFilter, chipRepos]);
  const visible = useMemo(
    (): PullRequest[] =>
      (pulls ?? []).filter(
        (p): boolean =>
          (showSnoozed || !isSnoozed(snoozes[p.id], p, Date.now())) &&
          (shownRepos.length === 0 || shownRepos.includes(p.repo)),
      ),
    [pulls, snoozes, showSnoozed, shownRepos],
  );
  const repoCounts = useMemo((): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const p of pulls ?? []) counts.set(p.repo, (counts.get(p.repo) ?? 0) + 1);
    return counts;
  }, [pulls]);
  const changeRepoFilter = (next: string[]): void => {
    setRepoFilter(next);
    void saveValue("repoFilter", next);
  };
  const toggleBoardView = (): void => {
    setBoardView((v) => {
      const next = v === "list" ? "columns" : "list";
      void saveValue("boardView", next);
      return next;
    });
  };
  const toggleDetailed = (): void => {
    setDetailed((on) => {
      void saveValue("boardDetailed", !on);
      return !on;
    });
  };
  /** From an "Aguardando" card: a draft becomes ready, then the usual reviewers are asked. */
  const askReview = async (pr: PullRequest, logins: string[]): Promise<void> => {
    if (config === null) return;
    if (pr.isDraft) await markReady(config, pr.id);
    if (logins.length > 0) await requestReviewers(config, pr, logins);
    forceRefetch.current.add(pr.id);
    void refresh();
  };
  const groups = useMemo(() => board(visible, me ?? ""), [visible, me]);
  const deps = useMemo(
    () => dependencyIndex([...(pulls ?? []), ...Object.values(extra).filter((p): boolean => p.closed === undefined)]),
    [pulls, extra],
  );
  // j/k follow what is on screen: the list's groups, or the columns.
  const ordered = useMemo(
    (): TriagedPull[] =>
      boardView === "columns"
        ? COLUMNS.flatMap((c): TriagedPull[] => groups[c])
        : holderGroups(groups).flatMap((g): TriagedPull[] => g.items),
    [groups, boardView],
  );
  const chains = useMemo((): TriagedPull[][][] => {
    const byId = new Map(ordered.map((t): [string, TriagedPull] => [t.pr.id, t]));
    const triaged = (p: PullRequest): TriagedPull[] => {
      const t = byId.get(p.id);
      return t === undefined ? [] : [t];
    };
    return chainsOf(
      ordered.map((t): PullRequest => t.pr),
      deps,
    ).map((chain): TriagedPull[][] => chain.map((step): TriagedPull[] => step.flatMap(triaged)));
  }, [ordered, deps]);
  const outside = selectedId === null ? undefined : extra[selectedId];
  const selected =
    ordered.find((p): boolean => p.pr.id === selectedId) ??
    (outside === undefined ? null : { pr: outside, triage: triage(outside, me ?? "") });

  const loadDetail = useCallback(
    async (id: string): Promise<void> => {
      if (config === null) return;
      setDetails((d) => (d[id]?.status === "ready" ? d : { ...d, [id]: { status: "loading" } }));
      try {
        const detail = await fetchDetail(config, id);
        setDetails((d) => ({ ...d, [id]: { status: "ready", detail } }));
      } catch (e) {
        setDetails((d) => ({ ...d, [id]: { status: "error", message: errorMessage(e) } }));
      }
    },
    [config],
  );

  // Opening a PR loads it, and so does a sync that finds it changed on GitHub: replies an agent posts from the
  // terminal, a review, a push. Without the second, the open PR kept what it showed when it was opened.
  const selectedStamp = selected?.pr.updatedAt;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the stamp is the trigger; loadDetail reads the id
  useEffect((): void => {
    if (selectedId !== null) void loadDetail(selectedId);
  }, [selectedId, selectedStamp, loadDetail]);

  const agentForRepo = (repo: string): Agent | undefined =>
    config === null ? undefined : agentFor(config, repo, agentPicks[repo]);

  /** Clones once and returns the PR's worktree; cached so AI runs and the terminal share it. */
  const ensureWorktree = useCallback(
    async (pr: PullRequest): Promise<string> => {
      const known = worktrees[pr.id];
      if (known !== undefined || config === null) return known ?? "";
      const [owner = "", repo = ""] = pr.repo.split("/");
      const cwd = await prepareWorktree({
        repoUrl: pr.repoUrl,
        owner,
        repo,
        number: pr.number,
        headRef: pr.headRef,
        isCrossRepository: pr.isCrossRepository,
        baseRef: pr.baseRef,
        workspaceDir: config.workspaceDir,
      });
      setWorktrees((w) => ({ ...w, [pr.id]: cwd }));
      return cwd;
    },
    [config, worktrees],
  );

  /** Starts the interactive agent in `cwd` under `key` (a PR id or a task id). */
  const spawnAgent = useCallback(
    async (
      key: string,
      repo: string,
      cwdFor: () => Promise<string>,
      prompt: string,
      context?: string,
    ): Promise<void> => {
      if (config === null) return;
      const current = sessions[key];
      if (current?.status === "running" || current?.status === "preparing") return;
      const agent = agentFor(config, repo, agentPicks[repo]);
      if (agent === undefined) return;
      setSessions((s) => ({ ...s, [key]: { status: "preparing", agentName: agent.name } }));
      try {
        const cwd = await cwdFor();
        if (context !== undefined) await writeAgentContext(cwd, config.workspaceDir, context);
        const sessionId = await ptySpawn(cwd, agentCommand(agent, prompt), INITIAL_ROWS, INITIAL_COLS);
        setSessions((s) => ({ ...s, [key]: { status: "running", agentName: agent.name, sessionId, cwd } }));
      } catch (e) {
        setSessions((s) => ({ ...s, [key]: { status: "error", agentName: agent.name, message: errorMessage(e) } }));
      }
    },
    [config, sessions, agentPicks],
  );

  const openAgent = useCallback(
    async (item: TriagedPull, prompt?: string, context?: string): Promise<void> => {
      if (me === null) return;
      await spawnAgent(
        item.pr.id,
        item.pr.repo,
        async (): Promise<string> => await ensureWorktree(item.pr),
        prompt ?? agentPrompt(item.pr, me),
        context,
      );
    },
    [me, spawnAgent, ensureWorktree],
  );

  /** Headless AI bound to a worktree; null when the selected agent has no headless command. */
  const aiIn = (repo: string, cwdFor: () => Promise<string>): PrAi | null => {
    const agent = agentForRepo(repo);
    if (config === null || agent === undefined || agent.headless.trim() === "") return null;
    return {
      agentName: agent.name,
      run: async (prompt: string, context: string): Promise<string> =>
        await agentRun(await cwdFor(), config.workspaceDir, headlessCommand(agent, prompt), context),
    };
  };

  const aiFor = (pr: PullRequest): PrAi | null => aiIn(pr.repo, async (): Promise<string> => await ensureWorktree(pr));

  const analyze = async (item: TriagedPull, files: PrFile[]): Promise<void> => {
    const ai = aiFor(item.pr);
    const state = details[item.pr.id];
    if (ai === null) return;
    const id = item.pr.id;
    setAiStates((a) => ({ ...a, [id]: { status: "running" } }));
    try {
      const detail = state?.status === "ready" ? state.detail : null;
      // What reviewers already said goes along, so the analysis does not raise the same points again.
      const said: Said[] = [
        ...(detail?.threads ?? []).flatMap((t): Said[] =>
          t.comments.map(
            (c): Said => ({
              author: c.author,
              where: t.line === null ? t.path : `${t.path}:${t.line}`,
              resolved: t.isResolved,
              text: htmlToText(c.bodyHTML),
            }),
          ),
        ),
        ...(detail?.timeline ?? []).map(
          (c): Said => ({ author: c.author, where: null, resolved: false, text: htmlToText(c.bodyHTML) }),
        ),
      ];
      const prompt = reviewPrompt(agentForRepo(item.pr.repo)?.reviewCommand ?? "");
      const output = await ai.run(prompt, diffContext(item.pr, detail?.body ?? "", files, said));
      const { review, comments } = readReview(output, files);
      setAiStates((a) => ({ ...a, [id]: { status: "done", review } }));
      // A new pass replaces the previous AI suggestions and keeps everything I wrote.
      setDrafts((d) => ({ ...d, [id]: [...(d[id] ?? []).filter((c): boolean => !c.fromAi), ...comments] }));
    } catch (e) {
      setAiStates((a) => ({ ...a, [id]: { status: "error", message: errorMessage(e) } }));
    }
  };

  const replyDrafter = (item: TriagedPull): ReplyDrafter => {
    const ai = aiFor(item.pr);
    if (ai === null) return null;
    return async (thread): Promise<string> => {
      const talk = thread.comments.map((c) => ({ author: c.author, text: htmlToText(c.bodyHTML) }));
      return stripFence(
        await ai.run(REPLY_PROMPT, replyContext(item.pr, thread.path, thread.line, thread.diffHunk, talk)),
      );
    };
  };

  const snooze = (item: TriagedPull, choice: SnoozeChoice): void => {
    const next = { ...snoozes };
    if (choice === "wake") delete next[item.pr.id];
    else next[item.pr.id] = { until: wakeTime(choice, new Date()), updatedAt: item.pr.updatedAt };
    // Entries that already woke up are dropped so the store does not grow forever.
    const live = Object.fromEntries(
      Object.entries(next).filter(([id, sn]): boolean => {
        const pr = pulls?.find((p): boolean => p.id === id);
        return pr !== undefined && isSnoozed(sn, pr, Date.now());
      }),
    );
    setSnoozes(live);
    void saveValue("snoozes", live);
    if (choice !== "wake" && !showSnoozed) navigate(null);
  };

  const saveTasks = (next: Record<string, Task>): void => {
    setTasks(next);
    void saveValue("tasks", next);
  };

  /** For changes decided after a long await: applies `change` to the latest tasks, not a stale render's copy. */
  const updateTasks = (change: (all: Record<string, Task>) => Record<string, Task>): void => {
    setTasks((all) => {
      const next = change(all);
      void saveValue("tasks", next);
      return next;
    });
  };

  const createTask = async (repo: string, branch: string, text: string, issue?: number): Promise<void> => {
    if (config === null) return;
    setNewTaskOpen(false);
    setTaskSeed(null);
    const repoUrl =
      pulls?.find((p): boolean => p.repo === repo)?.repoUrl ?? `https://${webHost(config.apiUrl)}/${repo}`;
    const id = `${TASK_PREFIX}${repo}:${branch}`;
    const task: Task = { id, repo, repoUrl, branch, text, cwd: null, ...(issue === undefined ? {} : { issue }) };
    saveTasks({ ...tasks, [id]: task });
    setView("board");
    navigate(id);
    const [owner = "", name = ""] = repo.split("/");
    await spawnAgent(
      id,
      repo,
      async (): Promise<string> => {
        const cwd = await prepareBranch({ repoUrl, owner, repo: name, branch, workspaceDir: config.workspaceDir });
        setTasks((t) => {
          const next = { ...t, [id]: { ...task, cwd } };
          void saveValue("tasks", next);
          return next;
        });
        return cwd;
      },
      contextPrompt(
        "Implement the task below in this worktree (a fresh branch off the default branch). Follow the repository's conventions, add or update tests, and run them. Do not commit or push: I review the diff and open the PR from prdesk.",
      ),
      `# Task\n\n${text}`,
    );
  };

  // ── Missions: one plan.md, one worktree and agent per repo. Files on disk are the source of truth. ──

  const saveMission = async (m: Mission): Promise<void> => {
    if (config === null) return;
    setMissions((all) => [m, ...all.filter((x): boolean => x.id !== m.id)]);
    await missionWrite(config.workspaceDir, m.id, "mission.json", JSON.stringify(m, null, 2));
  };

  const loadMissions = async (): Promise<void> => {
    if (config === null) return;
    try {
      const raw = await missionList(config.workspaceDir);
      const list = raw.flatMap((text): Mission[] => {
        try {
          return [JSON.parse(text) as Mission];
        } catch {
          // A hand-broken mission.json hides that mission; its folder and plan.md stay untouched.
          return [];
        }
      });
      list.sort((a, b): number => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      setMissions(list);
      const plans = await Promise.all(
        list.map(
          async (m): Promise<[string, string]> => [m.id, await missionRead(config.workspaceDir, m.id, "plan.md")],
        ),
      );
      setMissionPlans(Object.fromEntries(plans));
      await loadNotes(list);
      // A delivered mission is done once every one of its PRs is merged or closed.
      for (const m of list.filter((x): boolean => x.phase === "delivered")) {
        const states = await Promise.all(
          m.parts.map(
            async (p): Promise<boolean> =>
              p.pr === undefined ? false : (await fetchPull(config, p.repo, p.pr)).closed !== undefined,
          ),
        );
        if (states.every(Boolean)) await saveMission({ ...m, phase: "done" });
      }
    } catch (e) {
      console.warn("[App.missions] load failed", errorMessage(e));
    }
  };
  const loadMissionsRef = useRef(loadMissions);
  loadMissionsRef.current = loadMissions;

  /** Re-reads notes.md of every part still being worked on. */
  const loadNotes = async (list: Mission[]): Promise<void> => {
    if (config === null) return;
    const live = list
      .filter((m): boolean => m.phase === "running")
      .flatMap((m): MissionPart[] => m.parts.filter((p): boolean => p.cwd !== null && p.pr === undefined));
    const read = await Promise.allSettled(
      live.map(
        async (p): Promise<[string, string]> => [p.taskId, await readAgentNotes(p.cwd ?? "", config.workspaceDir)],
      ),
    );
    const notes = read.flatMap((r): [string, string][] => (r.status === "fulfilled" ? [r.value] : []));
    if (notes.length > 0) setPartNotes((all) => ({ ...all, ...Object.fromEntries(notes) }));
  };

  const readPlan = async (id: string): Promise<string> => {
    if (config === null) return "";
    const text = await missionRead(config.workspaceDir, id, "plan.md");
    setMissionPlans((p) => ({ ...p, [id]: text }));
    return text;
  };

  const writePlan = async (id: string, text: string): Promise<void> => {
    if (config === null) return;
    await missionWrite(config.workspaceDir, id, "plan.md", text);
    setMissionPlans((p) => ({ ...p, [id]: text }));
  };

  const repoUrlOf = (repo: string): string =>
    pulls?.find((p): boolean => p.repo === repo)?.repoUrl ?? `https://${webHost(config?.apiUrl ?? "")}/${repo}`;

  const missionPart = (repo: string, branch: string): MissionPart => ({
    repo,
    repoUrl: repoUrlOf(repo),
    branch,
    taskId: `${TASK_PREFIX}${repo}:${branch}`,
    cwd: null,
  });

  /** Worktrees for every part that has none yet; failures are reported per repo and the rest keep theirs. */
  const prepareParts = async (m: Mission): Promise<Mission> => {
    if (config === null) return m;
    const results = await Promise.allSettled(
      m.parts.map(async (p): Promise<MissionPart> => {
        if (p.cwd !== null) return p;
        const [owner = "", name = ""] = p.repo.split("/");
        const cwd = await prepareBranch({
          repoUrl: p.repoUrl,
          owner,
          repo: name,
          branch: p.branch,
          workspaceDir: config.workspaceDir,
        });
        return { ...p, cwd };
      }),
    );
    const parts = results.map(
      (r, i): MissionPart => (r.status === "fulfilled" ? r.value : (m.parts[i] as MissionPart)),
    );
    const failed = results.flatMap((r, i): string[] =>
      r.status === "rejected" ? [`${m.parts[i]?.repo}: ${errorMessage(r.reason)}`] : [],
    );
    const { error: _old, ...rest } = m;
    return failed.length === 0
      ? { ...rest, parts }
      : { ...rest, parts, error: `Não deu para preparar ${failed.join("; ")}` };
  };

  /** Runs the planning agent over every worktree and writes plan.md; without a headless agent the template stays. */
  const planMission = async (start: Mission): Promise<void> => {
    if (config === null) return;
    const agent = agentForRepo(start.parts[0]?.repo ?? "");
    if (agent === undefined || agent.headless.trim() === "") {
      await saveMission({
        ...start,
        phase: "ready",
        error: "O agente escolhido não roda headless: escreva o plano à mão.",
      });
      return;
    }
    const planning: Mission = { ...start, phase: "planning" };
    await saveMission(planning);
    try {
      const worktrees = planning.parts.flatMap((p): { repo: string; path: string }[] =>
        p.cwd === null ? [] : [{ repo: p.repo, path: p.cwd }],
      );
      const out = await missionAgent(
        config.workspaceDir,
        planning.id,
        headlessCommand(agent, planPrompt(planning.id)),
        "request.md",
        planRequest(planning.request, worktrees),
      );
      await writePlan(planning.id, `${stripFence(out).trim()}\n`);
      const { error: _old, ...rest } = planning;
      await saveMission({ ...rest, phase: "ready" });
    } catch (e) {
      await saveMission({ ...planning, phase: "ready", error: `O agente não conseguiu planejar: ${errorMessage(e)}` });
    }
  };

  const createMission = async (request: string, repos: string[]): Promise<void> => {
    if (config === null) return;
    setNewMissionOpen(false);
    const title = (request.split("\n")[0] ?? "").trim().slice(0, MAX_MISSION_TITLE);
    let id = missionId(title, new Date());
    // Two missions with the same title on the same day get -2, -3…
    for (let n = 2; missions.some((m): boolean => m.id === id); n++) id = `${missionId(title, new Date())}-${n}`;
    const branch = `prdesk/${slugify(title) || "missao"}`;
    const mission: Mission = {
      id,
      title,
      request,
      createdAt: new Date().toISOString(),
      phase: "preparing",
      parts: repos.map((r): MissionPart => missionPart(r, branch)),
    };
    setOpenMissionId(id);
    setView("missions");
    await saveMission(mission);
    await writePlan(id, planTemplate(title, repos));
    const prepared = await prepareParts(mission);
    await saveMission(prepared);
    if (prepared.error === undefined) await planMission(prepared);
  };

  const replanMission = async (id: string): Promise<void> => {
    const m = missions.find((x): boolean => x.id === id);
    if (m === undefined) return;
    const prepared = await prepareParts({ ...m, phase: "preparing" });
    await saveMission(prepared);
    if (prepared.error === undefined) await planMission(prepared);
  };

  /** One task and agent per plan part; repos the plan added get their worktree first. */
  const launchMission = async (id: string): Promise<void> => {
    const m = missions.find((x): boolean => x.id === id);
    if (config === null || m === undefined) return;
    const text = await readPlan(id);
    const parsed = parsePlan(text);
    if (!parsed.ok) {
      await saveMission({ ...m, error: parsed.error });
      return;
    }
    const branch = m.parts[0]?.branch ?? `prdesk/${slugify(m.title) || "missao"}`;
    const parts = parsed.plan.parts.map(
      (pp): MissionPart => m.parts.find((p): boolean => p.repo === pp.repo) ?? missionPart(pp.repo, branch),
    );
    const prepared = await prepareParts({ ...m, parts });
    if (prepared.error !== undefined) {
      await saveMission(prepared);
      return;
    }
    const title = parsed.plan.title || m.title;
    const next: Record<string, Task> = {};
    for (const p of prepared.parts) {
      next[p.taskId] = {
        id: p.taskId,
        repo: p.repo,
        repoUrl: p.repoUrl,
        branch: p.branch,
        text: `${title} · ${p.repo}`,
        cwd: p.cwd,
        mission: id,
      };
    }
    updateTasks((all) => ({ ...all, ...next }));
    await saveMission({ ...prepared, phase: "running", propagated: planHash(text) });
    await Promise.all(
      prepared.parts.map(async (p): Promise<void> => {
        const part = parsed.plan.parts.find((pp): boolean => pp.repo === p.repo);
        const cwd = p.cwd;
        if (part === undefined || cwd === null) return;
        await writeAgentContext(cwd, config.workspaceDir, text, "plan.md");
        await spawnAgent(
          p.taskId,
          p.repo,
          async (): Promise<string> => cwd,
          contextPrompt(partTask(title, p.repo, prepared.parts.length)),
          partContext(part),
        );
      }),
    );
  };

  // plan.md may be edited in another editor: re-read missions when the app opens and whenever the window regains focus.
  useEffect((): (() => void) | undefined => {
    if (config === null) return undefined;
    void loadMissionsRef.current();
    const onFocus = (): void => void loadMissionsRef.current();
    window.addEventListener("focus", onFocus);
    return (): void => window.removeEventListener("focus", onFocus);
  }, [config]);

  const hasRunningMission = missions.some((m): boolean => m.phase === "running");
  const missionsRef = useRef(missions);
  missionsRef.current = missions;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the interval reads the latest missions through a ref
  useEffect((): (() => void) | undefined => {
    if (!hasRunningMission) return undefined;
    const timer = window.setInterval((): void => void loadNotes(missionsRef.current), NOTES_EVERY_MS);
    return (): void => window.clearInterval(timer);
  }, [hasRunningMission]);

  const partStatus = (m: Mission, p: MissionPart): PartStatus => {
    if (p.pr !== undefined) return "pr";
    const notes = partNotes[p.taskId] ?? "";
    if (contractChange(notes) !== null && m.seenNotes?.[p.repo] !== planHash(notes)) return "contract";
    const s = sessions[p.taskId];
    if (s === undefined) return "idle";
    if (s.status === "running") return s.quiet === true ? "waiting" : "working";
    return s.status;
  };

  /** Copies plan.md into every worktree and tells each running agent to re-read it. */
  const propagatePlan = async (id: string): Promise<void> => {
    const m = missions.find((x): boolean => x.id === id);
    if (config === null || m === undefined) return;
    const text = await readPlan(id);
    const parsed = parsePlan(text);
    if (!parsed.ok) {
      await saveMission({ ...m, error: parsed.error });
      return;
    }
    const live = m.parts.filter((p): boolean => p.cwd !== null && p.pr === undefined);
    await Promise.all(
      live.map(async (p): Promise<void> => {
        await writeAgentContext(p.cwd ?? "", config.workspaceDir, text, "plan.md");
        const s = sessions[p.taskId];
        // The trailing carriage return submits the line in the agent's prompt.
        if (s?.status === "running") await ptyWrite(s.sessionId, `${PROPAGATE_MESSAGE}\r`);
      }),
    );
    const seenNotes = Object.fromEntries(
      live.map((p): [string, string] => [p.repo, planHash(partNotes[p.taskId] ?? "")]),
    );
    const { error: _old, ...rest } = m;
    await saveMission({ ...rest, propagated: planHash(text), seenNotes });
  };

  /** One headless pass over every part's diff against the contract. */
  const checkMission = async (id: string): Promise<void> => {
    const m = missions.find((x): boolean => x.id === id);
    const agent = agentForRepo(m?.parts[0]?.repo ?? "");
    if (config === null || m === undefined || agent === undefined || agent.headless.trim() === "") return;
    setMissionChecks((c) => ({ ...c, [id]: { status: "running" } }));
    try {
      const parsed = parsePlan(await readPlan(id));
      const contract = parsed.ok ? parsed.plan.contract : "";
      const diffs = await Promise.all(
        m.parts
          .filter((p): boolean => p.cwd !== null)
          .map(
            async (p): Promise<{ repo: string; diff: string }> => ({
              repo: p.repo,
              diff: (await worktreeChanges(p.cwd ?? "", config.workspaceDir)).diff,
            }),
          ),
      );
      const out = await missionAgent(
        config.workspaceDir,
        id,
        headlessCommand(agent, checkPrompt(id)),
        "check.md",
        checkRequest(contract, diffs),
      );
      setMissionChecks((c) => ({ ...c, [id]: { status: "done", text: stripFence(out).trim() } }));
    } catch (e) {
      setMissionChecks((c) => ({ ...c, [id]: { status: "error", message: errorMessage(e) } }));
    }
  };

  /**
   * Commits, pushes and opens one draft PR per part in merge order, each naming the PRs it depends on. Stops at the
   * first failure; parts that already have a PR are skipped, so "Abrir PRs" again resumes where it stopped.
   */
  const deliverMission = async (id: string): Promise<void> => {
    const m = missions.find((x): boolean => x.id === id);
    if (config === null || m === undefined) return;
    const parsed = parsePlan(await readPlan(id));
    const order = parsed.ok ? mergeOrder(parsed.plan.parts) : null;
    if (!parsed.ok || order === null) {
      await saveMission({ ...m, error: parsed.ok ? "As dependências formam um ciclo." : parsed.error });
      return;
    }
    const title = parsed.plan.title || m.title;
    const pending = m.parts.filter((p): boolean => p.pr === undefined && p.cwd !== null);
    const changes = new Map(
      await Promise.all(
        pending.map(
          async (p): Promise<[string, Changes]> => [p.repo, await worktreeChanges(p.cwd ?? "", config.workspaceDir)],
        ),
      ),
    );
    const empty = pending.filter((p): boolean => {
      const c = changes.get(p.repo);
      return c === undefined || (c.files.length === 0 && (c.unpushed ?? 0) === 0);
    });
    if (empty.length > 0) {
      await saveMission({ ...m, error: `Sem mudanças ainda em ${empty.map((p): string => p.repo).join(", ")}.` });
      return;
    }
    const { error: _old, ...clean } = m;
    let current: Mission = clean;
    const numbers = new Map(m.parts.flatMap((p): [string, number][] => (p.pr === undefined ? [] : [[p.repo, p.pr]])));
    const opened: { task: Task | undefined; pr: PullRequest }[] = [];
    for (const step of order) {
      const part = current.parts.find((p): boolean => p.repo === step.repo);
      if (part === undefined || part.pr !== undefined || part.cwd === null) continue;
      const cwd = part.cwd;
      try {
        let prTitle = title;
        let body = step.body;
        const ai = aiIn(part.repo, async (): Promise<string> => cwd);
        if (ai !== null) {
          try {
            const diff = changes.get(part.repo)?.diff ?? "";
            const context = `# Task\n\n${title}\n\n${step.body}\n\n# Diff\n\n\`\`\`diff\n${diff}\n\`\`\``;
            ({ title: prTitle, body } = readDescription(await ai.run(DESCRIBE_PROMPT, context)));
          } catch (e) {
            // Degraded: the plan's own text describes the PR; it can be improved inside the PR.
            console.warn("[App.deliver] describe failed", part.repo, errorMessage(e));
          }
        }
        await commitAndPush(cwd, config.workspaceDir, prTitle, part.repoUrl);
        const after = step.dependsOn.flatMap((d): { repo: string; number: number }[] => {
          const n = numbers.get(d);
          return n === undefined ? [] : [{ repo: d, number: n }];
        });
        const number = await createPull(config, part.repo, part.branch, prTitle, prBody(body, title, after), true);
        numbers.set(part.repo, number);
        current = { ...current, parts: current.parts.map((p): MissionPart => (p === part ? { ...p, pr: number } : p)) };
        await saveMission(current);
        opened.push({ task: tasks[part.taskId], pr: await fetchPull(config, part.repo, number) });
      } catch (e) {
        current = { ...current, error: `Não deu para abrir a PR de ${part.repo}: ${errorMessage(e)}` };
        break;
      }
    }
    // Like a single task becoming a PR: the terminal session and worktree move to the PR, the task goes away.
    setExtra((x) => ({ ...x, ...Object.fromEntries(opened.map((o): [string, PullRequest] => [o.pr.id, o.pr])) }));
    setSessions((all) => {
      const next = { ...all };
      for (const { task, pr } of opened) {
        const moved = task === undefined ? undefined : next[task.id];
        if (task !== undefined) delete next[task.id];
        if (moved !== undefined) next[pr.id] = moved;
      }
      return next;
    });
    setWorktrees((w) => ({
      ...w,
      ...Object.fromEntries(
        opened.flatMap((o): [string, string][] => (o.task?.cwd == null ? [] : [[o.pr.id, o.task.cwd]])),
      ),
    }));
    const doneIds = new Set(opened.flatMap((o): string[] => (o.task === undefined ? [] : [o.task.id])));
    updateTasks((all) => Object.fromEntries(Object.entries(all).filter(([k]): boolean => !doneIds.has(k))));
    const allOpen = current.parts.every((p): boolean => p.pr !== undefined);
    await saveMission(allOpen && current.error === undefined ? { ...current, phase: "delivered" } : current);
    void refresh();
  };

  /** The task became a PR: the terminal session moves to it and the task goes away. */
  const taskOpened = async (task: Task, number: number): Promise<void> => {
    if (config === null) return;
    const pr = await fetchPull(config, task.repo, number);
    setExtra((x) => ({ ...x, [pr.id]: pr }));
    setSessions((all) => {
      const { [task.id]: moved, ...rest } = all;
      return moved === undefined ? rest : { ...rest, [pr.id]: moved };
    });
    if (task.cwd !== null) setWorktrees((w) => ({ ...w, [pr.id]: task.cwd ?? "" }));
    const { [task.id]: _done, ...rest } = tasks;
    saveTasks(rest);
    navigate(pr.id);
    void refresh();
  };

  const onSessionExit = useCallback((sessionId: number): void => {
    setSessions((all) => {
      const entry = Object.entries(all).find(([, s]): boolean => s.status === "running" && s.sessionId === sessionId);
      if (entry === undefined) return all;
      const [prId, s] = entry;
      return s.status === "running"
        ? { ...all, [prId]: { status: "exited", agentName: s.agentName, cwd: s.cwd } }
        : all;
    });
  }, []);

  // Refs, so the quiet callback stays stable (a new one would rebuild every terminal) yet reads current state.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const describeRef = useRef((_key: string): string => "");
  describeRef.current = (key: string): string => {
    const pr = pulls?.find((p): boolean => p.id === key) ?? extra[key];
    if (pr !== undefined) return `${shortRef(pr)} · ${pr.title}`;
    const task = tasks[key];
    if (task === undefined) return "";
    return task.mission === undefined ? `${task.repo} · ${task.text}` : `Missão ${task.text}`;
  };

  const onSessionQuiet = useCallback((sessionId: number, quiet: boolean): void => {
    const entry = Object.entries(sessionsRef.current).find(
      ([, s]): boolean => s.status === "running" && s.sessionId === sessionId,
    );
    if (entry === undefined) return;
    const [key, s] = entry;
    if (s.status !== "running" || (s.quiet ?? false) === quiet) return;
    setSessions((all) => {
      const current = all[key];
      return current?.status === "running" && current.sessionId === sessionId
        ? { ...all, [key]: { ...current, quiet } }
        : all;
    });
    // Only worth a notification when I am not already looking at that terminal.
    if (quiet && (!document.hasFocus() || selectedRef.current !== key)) {
      void notifyAgentQuiet(s.agentName, describeRef.current(key));
    }
  }, []);

  const closeSession = async (prId: string): Promise<void> => {
    const s = sessions[prId];
    if (s?.status === "running") await ptyKill(s.sessionId);
    setSessions((all) => {
      const { [prId]: _removed, ...rest } = all;
      return rest;
    });
  };

  const zoom = config?.zoom ?? 1;
  useEffect((): void => {
    setZoom(zoom).catch((): void => console.warn("[App.zoom] setZoom failed"));
  }, [zoom]);

  const changeZoom = (next: number): void => {
    if (config === null) return;
    const updated = { ...config, zoom: clampZoom(next) };
    setConfig(updated);
    void saveConfig(updated);
  };

  const saveSettings = async (next: Config): Promise<void> => {
    const saved = await saveConfig(next);
    setConfig(saved);
    await checkToken();
    setView("board");
  };

  // Entering or leaving a PR morphs the row's title into the detail heading.
  const navigate = (id: string | null): void => {
    // Back on the board, the card I was on stays highlighted.
    if (id === null && selectedId !== null) setCursor(selectedId);
    // A dependency chip can point at a PR the repo filter hides; opening it shows the whole board again.
    const hidden = pulls?.find((p): boolean => p.id === id && shownRepos.length > 0 && !shownRepos.includes(p.repo));
    if (hidden !== undefined) changeRepoFilter([]);
    const crossing = (id === null) !== (selectedId === null);
    if (crossing) transition((): void => setSelectedId(id));
    else setSelectedId(id);
  };

  const unread = feed.filter((a): boolean => Date.parse(a.updatedAt) > feedSeenAt).length;

  const openFeed = (): void => setFeedOpen(true);

  const startIssue = (issue: Issue): void => {
    setIssuesOpen(false);
    setTaskSeed({
      repo: issue.repo,
      text: `Resolve ${issue.repo}#${issue.number}: ${issue.title}\n\n${issue.body}`.slice(0, MAX_TASK_TEXT).trim(),
      branch: branchFor(`${issue.number} ${issue.title}`),
      issue: issue.number,
    });
    setNewTaskOpen(true);
  };

  const branchOpened = async (branch: StrayBranch, number: number): Promise<void> => {
    setStray(null);
    setRadar((r): Radar => ({ ...r, branches: r.branches.filter((b): boolean => b !== branch) }));
    await openRef({ repo: branch.repo, number });
    void refreshRef.current();
  };

  const closeFeed = (): void => {
    setFeedOpen(false);
    setFeedSeenAt(Date.now());
  };

  // Feed items open in the app: from the board when the PR is there, otherwise fetched on their own.
  const pickActivity = async (a: Activity): Promise<void> => {
    closeFeed();
    if (a.number === null) return;
    const ref = { repo: a.repo, number: a.number };
    setFocus(a.commentId === null ? null : { ...ref, commentId: a.commentId });
    await openRef(ref);
  };

  // Opens a PR by repo and number: from the board when it is there, otherwise fetched on its own.
  const openRef = async (ref: PrRef): Promise<void> => {
    if (config === null) return;
    setView("board");
    const pull = ordered.find((p): boolean => refKey(p.pr) === refKey(ref));
    if (pull !== undefined) {
      navigate(pull.pr.id);
      return;
    }
    try {
      const pr = await fetchPull(config, ref.repo, ref.number);
      setExtra((x) => ({ ...x, [pr.id]: pr }));
      navigate(pr.id);
    } catch (e) {
      setSync((s): Sync => ({ ...s, error: errorMessage(e) }));
    }
  };

  // Keyboard: j/k move, Enter open, c agent, o GitHub, r refresh, n feed, "," settings, Esc back.
  const keyRef = useRef<(e: KeyboardEvent) => void>((): void => {});
  keyRef.current = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && view === "board") {
      e.preventDefault();
      setPaletteOpen(true);
      return;
    }
    // ⌘= / ⌘- / ⌘0 scale the whole interface, like a browser.
    if (e.metaKey || e.ctrlKey) {
      const step = { "=": 0.1, "+": 0.1, "-": -0.1 }[e.key];
      if (step !== undefined || e.key === "0") {
        e.preventDefault();
        changeZoom(step === undefined ? 1 : zoom + step);
        return;
      }
    }
    const dialogOpen =
      paletteOpen || feedOpen || newTaskOpen || dailyOpen || helpOpen || issuesOpen || newMissionOpen || stray !== null || brokenBase !== null;
    if (e.metaKey || e.ctrlKey || e.altKey || dialogOpen) return;
    if (e.key === "Escape") {
      const mission = selectedId === null ? undefined : tasks[selectedId]?.mission;
      if (view !== "board" && hasToken === true) setView("board");
      else if (!isTyping(e.target)) {
        navigate(null);
        if (mission !== undefined) {
          setOpenMissionId(mission);
          setView("missions");
        }
      }
      return;
    }
    if (isTyping(e.target)) return;
    if (e.key === ",") {
      setView("settings");
      return;
    }
    if (e.key === "n") {
      openFeed();
      return;
    }
    if (e.key === "?") {
      setHelpOpen(true);
      return;
    }
    if (e.key === "i") {
      setIssuesOpen(true);
      return;
    }
    if (e.key === "p") {
      // Otherwise the "p" lands in the dialog's first field.
      e.preventDefault();
      setNewTaskOpen(true);
      return;
    }
    if (e.key === "t") {
      setView(view === "tree" ? "board" : "tree");
      return;
    }
    if (e.key === "m") {
      setView(view === "missions" ? "board" : "missions");
      return;
    }
    if (e.key === "b" && view === "board" && !inDetail) {
      toggleBoardView();
      return;
    }
    if (e.key === "d" && view === "board" && !inDetail && boardView === "columns") {
      toggleDetailed();
      return;
    }
    if (view !== "board") return;

    if (selectedId === null && /^[0-9]$/.test(e.key) && chipRepos.length > 1) {
      const repo = chipRepos[Number(e.key) - 1];
      if (e.key === "0") changeRepoFilter([]);
      else if (repo !== undefined) changeRepoFilter(toggleRepo(shownRepos, repo));
      return;
    }

    // On the full board j/k only move the highlight; inside a PR they switch PRs.
    const onBoard = selectedId === null;
    const index = ordered.findIndex((p): boolean => p.pr.id === (onBoard ? cursor : selectedId));
    const target = onBoard ? (ordered[index] ?? null) : selected;
    const step = (delta: number): void => {
      e.preventDefault();
      const next = ordered[Math.min(ordered.length - 1, Math.max(0, index === -1 ? 0 : index + delta))];
      if (next === undefined) return;
      if (onBoard) setCursor(next.pr.id);
      else navigate(next.pr.id);
    };
    switch (e.key) {
      case "j":
      case "ArrowDown":
        step(1);
        break;
      case "k":
      case "ArrowUp":
        step(-1);
        break;
      case "Enter":
        if (onBoard && target !== null && !(e.target instanceof HTMLButtonElement)) navigate(target.pr.id);
        break;
      case "c":
        if (target === null) break;
        // The terminal docks inside the PR, so from the board open the PR first or the agent runs out of sight.
        if (onBoard) navigate(target.pr.id);
        void openAgent(target);
        break;
      case "o":
        if (target !== null) void openUrl(target.pr.url);
        break;
      case "r":
        void refresh();
        if (selectedId !== null) void loadDetail(selectedId);
        break;
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs when the highlight moves; the DOM holds the row
  useEffect((): void => {
    document
      .querySelector(
        '.board:not(.rail) .row[aria-current="true"], .prlist:not(.is-compact) .pl-row[aria-current="true"]',
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  useEffect((): (() => void) => {
    const onKey = (e: KeyboardEvent): void => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return (): void => window.removeEventListener("keydown", onKey);
  }, []);

  if (config === null || hasToken === null) return <div className="app" aria-busy />;

  const selectedTask = selectedId?.startsWith(TASK_PREFIX) === true ? tasks[selectedId] : undefined;
  const session = selectedId === null ? undefined : sessions[selectedId];
  const inDetail = view === "board" && (selected !== null || selectedTask !== undefined);
  const knownRepos = [
    ...new Set([
      ...(pulls ?? []).map((p): string => p.repo),
      ...config.scopes.filter((sc): boolean => sc.includes("/")),
    ]),
  ].sort();
  const reopen = (): void => {
    if (selected !== null) void openAgent(selected);
    else if (selectedTask?.cwd != null) {
      const cwd = selectedTask.cwd;
      void spawnAgent(
        selectedTask.id,
        selectedTask.repo,
        async (): Promise<string> => cwd,
        contextPrompt("Continue the task below in this worktree. Do not commit or push."),
        `# Task\n\n${selectedTask.text}`,
      );
    }
  };
  const dockOpen = inDetail && session !== undefined;
  const syncText = sync.loading
    ? "Sincronizando…"
    : sync.error !== null
      ? `Falha ao sincronizar: ${sync.error}`
      : sync.at !== null
        ? `Sincronizado às ${clock(sync.at)}`
        : "Atualizar";
  // Mission parts show under their mission's chip, not one by one.
  const looseTasks = Object.values(tasks).filter((t): boolean => t.mission === undefined);
  const hasTasks = looseTasks.length > 0;
  const runningMissions = missions.filter((m): boolean => m.phase === "running").length;
  // The radar follows the repo filter like the board does.
  const inShown = (repo: string): boolean => shownRepos.length === 0 || shownRepos.includes(repo);
  const shownRadar: Radar = {
    branches: radar.branches.filter((b): boolean => inShown(b.repo)),
    broken: radar.broken.filter((b): boolean => inShown(b.repo)),
  };
  const hasRadar = shownRadar.branches.length > 0 || shownRadar.broken.length > 0;
  const agentStates = new Map(
    Object.entries(sessions).flatMap(([key, s]): [string, AgentState][] =>
      s.status === "preparing"
        ? [[key, "working"]]
        : s.status === "running"
          ? [[key, s.quiet ? "waiting" : "working"]]
          : [],
    ),
  );
  const mainClass = ["main", inDetail ? "is-detail" : "", dockOpen ? "has-dock" : ""].filter(Boolean).join(" ");

  // The PR above keeps at least DOCK_MIN_ABOVE px; the terminal at least DOCK_MIN px.
  const clampDock = (height: number, main: Element): number =>
    Math.round(Math.min(Math.max(height, DOCK_MIN), main.getBoundingClientRect().height - DOCK_MIN_ABOVE));
  const resizeDock = (e: React.PointerEvent<HTMLDivElement>): void => {
    const main = e.currentTarget.closest(".main");
    if (main === null) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    setDockDragging(true);
    let last = dockHeight;
    const move = (ev: PointerEvent): void => {
      last = clampDock(main.getBoundingClientRect().bottom - ev.clientY, main);
      setDockHeight(last);
    };
    const up = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      setDockDragging(false);
      if (last !== null) void saveValue("dockHeight", last);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  };
  const nudgeDock = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const main = e.currentTarget.closest(".main");
    const dock = e.currentTarget.parentElement;
    if (main === null || dock === null || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const next = clampDock(dock.getBoundingClientRect().height + (e.key === "ArrowUp" ? DOCK_STEP : -DOCK_STEP), main);
    setDockHeight(next);
    void saveValue("dockHeight", next);
  };

  return (
    <div className="app">
      <aside className="side" aria-label="prdesk">
        <button
          type="button"
          className="wordmark"
          title="Voltar às PRs"
          onClick={(): void => {
            setView("board");
            navigate(null);
          }}
        >
          prdesk
        </button>
        <nav className="side-nav" aria-label="Seções">
          <button
            type="button"
            className="side-item"
            aria-current={view === "board"}
            onClick={(): void => {
              setView("board");
              navigate(null);
            }}
          >
            <GitPullRequest size={16} strokeWidth={2} aria-hidden />
            <span className="side-label">Pull requests</span>
            {pulls !== null && <b>{visible.length}</b>}
          </button>
          <button
            type="button"
            className="side-item"
            title="Novidades (N)"
            onClick={openFeed}
            aria-label={unread > 0 ? `Novidades, ${unread} não lidas` : "Novidades"}
          >
            <Bell size={16} strokeWidth={2} aria-hidden />
            <span className="side-label">Novidades</span>
            {unread > 0 && <b className="is-new">{unread}</b>}
          </button>
          <button
            type="button"
            className="side-item"
            disabled={hasToken !== true}
            title="Issues atribuídas a você (I)"
            onClick={(): void => setIssuesOpen(true)}
          >
            <CircleDot size={16} strokeWidth={2} aria-hidden />
            <span className="side-label">Issues</span>
            {issues !== null && issues.length > 0 && <b>{issues.length}</b>}
          </button>
          {snoozedCount > 0 && (
            <button
              type="button"
              className="side-item"
              aria-pressed={showSnoozed}
              title={showSnoozed ? "Esconder as PRs adiadas" : "Mostrar as PRs adiadas na lista"}
              onClick={(): void => setShowSnoozed(!showSnoozed)}
            >
              <Clock size={16} strokeWidth={2} aria-hidden />
              <span className="side-label">Adiadas</span>
              <b>{snoozedCount}</b>
            </button>
          )}
          {chains.length > 0 && (
            <button
              type="button"
              className="side-item"
              aria-current={view === "chains"}
              title="PRs ligadas por dependência, na ordem de merge"
              onClick={(): void => setView(view === "chains" ? "board" : "chains")}
            >
              <Link2 size={16} strokeWidth={2} aria-hidden />
              <span className="side-label">Encadeadas</span>
              <b>{chains.length}</b>
            </button>
          )}
          <button
            type="button"
            className="side-item"
            aria-current={view === "tree"}
            title="Árvore de branches de um repositório (T)"
            onClick={(): void => setView(view === "tree" ? "board" : "tree")}
          >
            <GitGraph size={16} strokeWidth={2} aria-hidden />
            <span className="side-label">Árvore</span>
          </button>
          <button
            type="button"
            className="side-item"
            aria-current={view === "missions"}
            disabled={hasToken !== true}
            title="Missões: uma mudança em vários repos, um agente por repo (M)"
            onClick={(): void => setView(view === "missions" ? "board" : "missions")}
          >
            <Workflow size={16} strokeWidth={2} aria-hidden />
            <span className="side-label">Missões</span>
            {runningMissions > 0 && <b>{runningMissions}</b>}
          </button>
          <button
            type="button"
            className="side-item"
            disabled={hasToken !== true}
            title="Resumo para a daily"
            onClick={(): void => setDailyOpen(true)}
          >
            <CalendarCheck size={16} strokeWidth={2} aria-hidden />
            <span className="side-label">Daily</span>
          </button>
        </nav>
        {chipRepos.length > 1 && (
          <RepoFilter orgs={repoOrgs} filter={shownRepos} counts={repoCounts} onChange={changeRepoFilter} />
        )}
        <div className="side-foot">
          <UpdateButton />
          <button type="button" className="side-item" title="Como usar (?)" onClick={(): void => setHelpOpen(true)}>
            <CircleHelp size={16} strokeWidth={2} aria-hidden />
            <span className="side-label">Como usar</span>
          </button>
          <button
            type="button"
            className="side-item"
            title={me === null ? "Ajustes (,)" : `Ajustes (,) · conectado como @${me}`}
            aria-current={view === "settings"}
            onClick={(): void => setView("settings")}
          >
            <SettingsIcon size={16} strokeWidth={2} aria-hidden />
            <span className="side-label">Ajustes</span>
          </button>
        </div>
      </aside>

      <div className="shell">
        <header className="bar">
          <h1 className="bar-title">{VIEW_TITLE[view]}</h1>
          <button
            type="button"
            className={sync.error === null ? "bar-sync" : "bar-sync is-error"}
            onClick={(): void => void refresh()}
            disabled={sync.loading || hasToken !== true}
            title={`${syncText}. Atualizar agora (R)`}
            aria-live="polite"
          >
            <RefreshCw className={sync.loading ? "spin" : ""} size={13} strokeWidth={2} aria-hidden />
            <span className="bar-sync-text">{syncText}</span>
          </button>
          <span className="bar-gap" />
          {view === "board" && !inDetail && (
            <fieldset className="bar-seg" aria-label="Como mostrar as PRs (B)">
              <button
                type="button"
                aria-pressed={boardView === "list"}
                title="Lista, agrupada por quem está com a PR (B)"
                onClick={(): void => {
                  if (boardView !== "list") toggleBoardView();
                }}
              >
                <ListIcon size={15} strokeWidth={2} aria-hidden /> Lista
              </button>
              <button
                type="button"
                aria-pressed={boardView === "columns"}
                title="Colunas por status (B)"
                onClick={(): void => {
                  if (boardView !== "columns") toggleBoardView();
                }}
              >
                <Columns3 size={15} strokeWidth={2} aria-hidden /> Colunas
              </button>
            </fieldset>
          )}
          {view === "board" && !inDetail && boardView === "columns" && (
            <button
              type="button"
              className="bar-button"
              aria-pressed={detailed}
              title="Mostrar nos cards a linha do tempo, quem revisa e o tamanho da PR (D)"
              onClick={toggleDetailed}
            >
              <ActivityIcon size={15} strokeWidth={2} aria-hidden /> Detalhes
            </button>
          )}
          <button
            type="button"
            className="bar-search"
            title="Buscar PR (⌘K)"
            onClick={(): void => setPaletteOpen(true)}
          >
            <SearchIcon size={14} strokeWidth={2} aria-hidden /> <span>Buscar PR</span> <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            className="bar-primary"
            title="Nova PR com agente (P)"
            disabled={hasToken !== true}
            onClick={(): void => setNewTaskOpen(true)}
          >
            <GitPullRequestCreate size={15} strokeWidth={2} aria-hidden /> Nova PR
          </button>
        </header>

        {helpOpen && <HelpDialog onClose={(): void => setHelpOpen(false)} />}

        {feedOpen && (
          <Feed items={feed} seenAt={feedSeenAt} onPick={(a): void => void pickActivity(a)} onClose={closeFeed} />
        )}

        {newTaskOpen && (
          <NewTaskDialog
            repos={knownRepos}
            seed={taskSeed}
            onClose={(): void => {
              setNewTaskOpen(false);
              setTaskSeed(null);
            }}
            onCreate={(repo, branch, text, issue): void => void createTask(repo, branch, text, issue)}
          />
        )}

        {newMissionOpen && (
          <NewMissionDialog
            repos={knownRepos}
            onClose={(): void => setNewMissionOpen(false)}
            onCreate={(request, repos): void => void createMission(request, repos)}
          />
        )}

        {issuesOpen && (
          <IssuesDialog
            issues={issues}
            error={issuesError}
            onStart={startIssue}
            onOpenUrl={(url): void => void openUrl(url)}
            onClose={(): void => setIssuesOpen(false)}
          />
        )}

        {stray !== null && (
          <BranchPrDialog
            config={config}
            branch={stray}
            onCreated={(number): void => void branchOpened(stray, number)}
            onClose={(): void => setStray(null)}
          />
        )}

        {brokenBase !== null && (
          <BaseChecksDialog config={config} base={brokenBase} onClose={(): void => setBrokenBase(null)} />
        )}

        {dailyOpen && (
          <DailyDialog config={config} waiting={groups.waiting} onClose={(): void => setDailyOpen(false)} />
        )}

        {paletteOpen && (
          <Palette
            items={ordered}
            onClose={(): void => setPaletteOpen(false)}
            onPick={(id): void => {
              setPaletteOpen(false);
              navigate(id);
            }}
          />
        )}

        <main
          className={mainClass}
          {...(dockHeight === null ? {} : { style: { ["--dock" as string]: `${dockHeight}px` } })}
        >
          {view === "settings" && (
            <Settings
              config={config}
              firstRun={hasToken !== true}
              onSave={saveSettings}
              onTokenChange={(): void => void checkToken()}
              onClose={(): void => setView("board")}
              openRefs={new Set((pulls ?? []).map((p): string => refKey(p)))}
              busyPaths={
                new Set(Object.values(sessions).flatMap((s): string[] => (s.status === "running" ? [s.cwd] : [])))
              }
            />
          )}

          {view === "chains" && (
            <Chains
              chains={chains}
              onSelect={(id): void => {
                setView("board");
                navigate(id);
              }}
            />
          )}

          {view === "missions" && (
            <MissionsView
              missions={missions}
              selectedId={openMissionId}
              plans={missionPlans}
              notes={partNotes}
              checks={missionChecks}
              partStatus={partStatus}
              canPlan={(agentForRepo("")?.headless.trim() ?? "") !== ""}
              onSelect={setOpenMissionId}
              onNew={(): void => setNewMissionOpen(true)}
              onSavePlan={writePlan}
              onReloadPlan={(id): void => void readPlan(id)}
              onReveal={(id): void => {
                if (config === null) return;
                void missionPlanPath(config.workspaceDir, id).then(revealItemInDir);
              }}
              onReplan={(id): void => void replanMission(id)}
              onLaunch={(id): void => void launchMission(id)}
              onPropagate={(id): void => void propagatePlan(id)}
              onCheck={(id): void => void checkMission(id)}
              onDeliver={(id): void => void deliverMission(id)}
              onOpenPr={(repo, number): void => {
                setView("board");
                void openRef({ repo, number });
              }}
              onOpenPart={(taskId): void => {
                setView("board");
                navigate(taskId);
              }}
            />
          )}

          {view === "tree" && (
            <TreeView pulls={pulls ?? []} onOpenPr={(repo, number): void => void openRef({ repo, number })} />
          )}

          {view === "board" && !inDetail && (hasTasks || hasRadar || runningMissions > 0) && (
            <div className="strips">
              {runningMissions > 0 && (
                <nav className="tasks-strip" aria-label="Missões em andamento">
                  <span className="tasks-label">Missões</span>
                  {missions
                    .filter((m): boolean => m.phase === "running")
                    .map((m): ReactElement => {
                      const waiting = m.parts.filter((p): boolean =>
                        ["contract", "waiting", "error"].includes(partStatus(m, p)),
                      ).length;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className={waiting > 0 ? "task-chip is-bad" : "task-chip"}
                          onClick={(): void => {
                            setOpenMissionId(m.id);
                            setView("missions");
                          }}
                        >
                          <Workflow size={14} strokeWidth={2} aria-hidden />
                          <span className="task-text">{m.title}</span>
                          <span className="task-live">
                            {waiting > 0 ? `${waiting} aguardando você` : `${m.parts.length} repos`}
                          </span>
                        </button>
                      );
                    })}
                </nav>
              )}
              {hasTasks && (
                <nav className="tasks-strip" aria-label="Tarefas em andamento">
                  <span className="tasks-label">Em andamento</span>
                  {looseTasks.map(
                    (t): ReactElement => (
                      <button key={t.id} type="button" className="task-chip" onClick={(): void => navigate(t.id)}>
                        <GitPullRequestCreate size={14} strokeWidth={2} aria-hidden />
                        <span className="task-repo">{t.repo}</span>
                        <span className="task-text">{t.text}</span>
                        {sessions[t.id]?.status === "running" && <span className="task-live pulse">agente</span>}
                      </button>
                    ),
                  )}
                </nav>
              )}
              {hasRadar && (
                <RadarStrip radar={shownRadar} onOpenBranch={setStray} onOpenBase={setBrokenBase} />
              )}
            </div>
          )}

          {view === "board" && !inDetail && boardView === "list" && (
            <PrList
              groups={groups}
              loading={pulls === null}
              selectedId={cursor}
              onSelect={navigate}
              onAskReview={askReview}
            />
          )}
          {view === "board" && !inDetail && boardView === "columns" && (
            <Board
              groups={groups}
              deps={deps}
              loading={pulls === null}
              selectedId={cursor}
              agents={agentStates}
              detailed={detailed}
              me={me ?? ""}
              onAskReview={askReview}
              onSelect={navigate}
            />
          )}

          {inDetail && selectedTask !== undefined && selected === null && (
            <>
              <aside className="rail-wrap">
                <button
                  type="button"
                  className="back"
                  onClick={(): void => {
                    navigate(null);
                    if (selectedTask.mission !== undefined) {
                      setOpenMissionId(selectedTask.mission);
                      setView("missions");
                    }
                  }}
                >
                  <ArrowLeft size={16} strokeWidth={2} aria-hidden />
                  <span>{selectedTask.mission === undefined ? "Voltar às PRs" : "Voltar à missão"}</span>
                  <kbd>Esc</kbd>
                </button>
                <PrList groups={groups} loading={false} selectedId={null} compact onSelect={navigate} />
              </aside>
              <TaskView
                key={selectedTask.id}
                task={selectedTask}
                config={config}
                ai={
                  selectedTask.cwd === null
                    ? null
                    : aiIn(selectedTask.repo, async (): Promise<string> => selectedTask.cwd ?? "")
                }
                agentName={agentForRepo(selectedTask.repo)?.name ?? "agente"}
                agentBusy={session?.status === "preparing" || session?.status === "running"}
                onOpenAgent={reopen}
                onCreated={(number): void => void taskOpened(selectedTask, number)}
              />
            </>
          )}

          {inDetail && selected !== null && (
            <>
              <aside className="rail-wrap">
                <button type="button" className="back" onClick={(): void => navigate(null)}>
                  <ArrowLeft size={16} strokeWidth={2} aria-hidden />
                  <span>Voltar às PRs</span>
                  <kbd>Esc</kbd>
                </button>
                <PrList groups={groups} loading={false} selectedId={selectedId} compact onSelect={navigate} />
                <p className="rail-hint">
                  <kbd>J</kbd> <kbd>K</kbd> para navegar
                </p>
              </aside>
              <Detail
                key={selected.pr.id}
                item={selected}
                focusComment={focus !== null && refKey(focus) === refKey(selected.pr) ? focus.commentId : null}
                onFocused={clearFocus}
                me={me ?? ""}
                config={config}
                state={details[selected.pr.id] ?? { status: "loading" }}
                agents={config.agents}
                agentId={agentForRepo(selected.pr.repo)?.id ?? ""}
                agentBusy={session?.status === "preparing"}
                agentBlocked={session?.status === "running" || session?.status === "preparing"}
                worktree={session?.status === "running" || session?.status === "exited" ? session.cwd : null}
                drafts={drafts[selected.pr.id] ?? NO_DRAFTS}
                aiState={aiStates[selected.pr.id] ?? IDLE_AI}
                ai={aiFor(selected.pr)}
                draftReply={replyDrafter(selected)}
                snoozed={isSnoozed(snoozes[selected.pr.id], selected.pr, now)}
                deps={deps.get(selected.pr.id) ?? NO_DEPS}
                repoPulls={(pulls ?? []).filter((p): boolean => p.repo === selected.pr.repo)}
                onOpenRef={(ref): void => void openRef(ref)}
                onAgentChange={(id): void => setAgentPicks((p) => ({ ...p, [selected.pr.repo]: id }))}
                onOpenAgent={(prompt?: string, context?: string): void => void openAgent(selected, prompt, context)}
                onOpenGithub={(): void => void openUrl(selected.pr.url)}
                onDrafts={(next): void => setDrafts((d) => ({ ...d, [selected.pr.id]: next }))}
                onAnalyze={(files): void => void analyze(selected, files)}
                onSnooze={(choice): void => snooze(selected, choice)}
                onChanged={(): void => {
                  forceRefetch.current.add(selected.pr.id);
                  void loadDetail(selected.pr.id);
                  void refresh();
                }}
              />
            </>
          )}

          <section className="dock" hidden={!dockOpen} aria-label="Terminal do agente">
            {/* biome-ignore lint/a11y/useSemanticElements: a focusable splitter is an ARIA separator; <hr> cannot take drag or keys */}
            <div
              className={dockDragging ? "dock-grip is-dragging" : "dock-grip"}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Redimensionar o terminal (setas para cima e para baixo)"
              aria-valuenow={dockHeight ?? undefined}
              tabIndex={0}
              onPointerDown={resizeDock}
              onKeyDown={nudgeDock}
              onDoubleClick={(): void => {
                setDockHeight(null);
                void saveValue("dockHeight", null);
              }}
            />
            {selectedId !== null && session !== undefined && (
              <div className="term-bar">
                <span className="term-title">
                  <TerminalIcon className="term-icon" size={15} strokeWidth={2} aria-hidden />
                  <b>{session.agentName}</b>
                  {(session.status === "running" || session.status === "exited") && (
                    <span className="term-cwd">{session.cwd}</span>
                  )}
                </span>
                <span className="term-actions">
                  {session.status === "exited" && (
                    <button type="button" className="text-button" onClick={reopen}>
                      Abrir de novo
                    </button>
                  )}
                  {session.status !== "preparing" && (
                    <button type="button" className="text-button" onClick={(): void => void closeSession(selectedId)}>
                      <X size={15} strokeWidth={2} aria-hidden />
                      {session.status === "running" ? "Encerrar" : "Fechar"}
                    </button>
                  )}
                </span>
              </div>
            )}
            {session?.status === "preparing" && (
              <p className="term-state pulse">
                Preparando o worktree. Na primeira vez o repo é clonado, e isso pode levar um tempo
              </p>
            )}
            {session?.status === "error" && <p className="term-state error">{session.message}</p>}
            {session?.status === "exited" && <p className="term-state">A sessão terminou.</p>}
            {Object.entries(sessions).map(([prId, s]): ReactElement | null =>
              s.status === "running" ? (
                <Terminal
                  key={prId}
                  sessionId={s.sessionId}
                  visible={dockOpen && prId === selectedId}
                  onExit={onSessionExit}
                  onQuiet={onSessionQuiet}
                />
              ) : null,
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
