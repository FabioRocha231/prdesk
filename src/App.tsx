import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  Bell,
  CalendarCheck,
  CircleHelp,
  Clock,
  GitGraph,
  GitPullRequestCreate,
  Link2,
  RefreshCw,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { Board } from "./components/Board";
import { Chains } from "./components/Chains";
import { DailyDialog } from "./components/Daily";
import { Detail, type DetailState, type PrAi, type SnoozeChoice } from "./components/Detail";
import { Feed } from "./components/Feed";
import { TreeView } from "./components/GitTree";
import { HelpDialog } from "./components/Help";
import { Palette } from "./components/Palette";
import type { AiState } from "./components/Review";
import { Settings } from "./components/Settings";
import { NewTaskDialog, type Task, TaskView } from "./components/Task";
import { Terminal } from "./components/Terminal";
import { htmlToText, type ReplyDrafter } from "./components/Threads";
import { diffContext, REPLY_PROMPT, REVIEW_PROMPT, readReview, replyContext, stripFence } from "./lib/ai";
import {
  type Agent,
  agentCommand,
  agentPrompt,
  type Config,
  contextPrompt,
  headlessCommand,
  loadConfig,
  saveConfig,
} from "./lib/config";
import { chains as chainsOf, type Deps, dependencyIndex, type PrRef, refKey } from "./lib/deps";
import { clock } from "./lib/format";
import { fetchDetail, fetchPull, fetchPulls, type PullCache, pullsFromCache } from "./lib/github";
import {
  type Activity,
  agentRun,
  errorMessage,
  githubNotifications,
  prepareBranch,
  prepareWorktree,
  ptyKill,
  ptySpawn,
  tokenStatus,
  writeAgentContext,
} from "./lib/ipc";
import { COLUMNS, type DraftComment, type PrFile, type PullRequest, type TriagedPull } from "./lib/model";
import { mergeFeed, notifyActivity, notifyBranchChanges, setBadge } from "./lib/notify";
import { loadCached, loadValue, saveCached, saveValue } from "./lib/persist";
import { isSnoozed, type Snoozes, wakeTime } from "./lib/snooze";
import { board, triage } from "./lib/triage";

const SECOND = 1000;
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
const BOARD_CACHE_KEY = "board";

/** "https://api.github.com/graphql" → "github.com"; a GHE host stays as is. */
function webHost(apiUrl: string): string {
  return new URL(apiUrl).host.replace(/^api\./, "");
}

type Sync = { loading: boolean; at: Date | null; error: string | null };

type Session =
  | { status: "preparing"; agentName: string }
  | { status: "running"; agentName: string; sessionId: number; cwd: string }
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
  const [view, setView] = useState<"board" | "settings" | "tree" | "chains">("board");
  const [me, setMe] = useState<string | null>(null);
  const [pulls, setPulls] = useState<PullRequest[] | null>(null);
  const [sync, setSync] = useState<Sync>({ loading: false, at: null, error: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [agentId, setAgentId] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [feed, setFeed] = useState<Activity[]>([]);
  // PRs opened from the feed that are not on the board (closed, merged, or outside the scopes).
  const [extra, setExtra] = useState<Record<string, PullRequest>>({});
  const [feedOpen, setFeedOpen] = useState(false);
  const [feedSeenAt, setFeedSeenAt] = useState((): number => Date.now());
  // Review drafts and AI results live here so they survive switching PRs.
  const [drafts, setDrafts] = useState<Record<string, DraftComment[]>>({});
  const [aiStates, setAiStates] = useState<Record<string, AiState>>({});
  const [worktrees, setWorktrees] = useState<Record<string, string>>({});
  const [snoozes, setSnoozes] = useState<Snoozes>({});
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [newTaskOpen, setNewTaskOpen] = useState(false);
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
      setAgentId(loaded.defaultAgentId);
      setSnoozes(await loadValue<Snoozes>("snoozes", {}));
      setTasks(await loadValue<Record<string, Task>>("tasks", {}));
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
  }, [config, pulls]);

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
  const visible = useMemo(
    (): PullRequest[] => (pulls ?? []).filter((p): boolean => showSnoozed || !isSnoozed(snoozes[p.id], p, Date.now())),
    [pulls, snoozes, showSnoozed],
  );
  const groups = useMemo(() => board(visible, me ?? ""), [visible, me]);
  const deps = useMemo(
    () => dependencyIndex([...(pulls ?? []), ...Object.values(extra).filter((p): boolean => p.closed === undefined)]),
    [pulls, extra],
  );
  const ordered = useMemo((): TriagedPull[] => COLUMNS.flatMap((c): TriagedPull[] => groups[c]), [groups]);
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

  useEffect((): void => {
    if (selectedId !== null) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const currentAgent = (): Agent | undefined =>
    config?.agents.find((a): boolean => a.id === agentId) ?? config?.agents[0];

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
    async (key: string, cwdFor: () => Promise<string>, prompt: string, context?: string): Promise<void> => {
      if (config === null) return;
      const current = sessions[key];
      if (current?.status === "running" || current?.status === "preparing") return;
      const agent = config.agents.find((a): boolean => a.id === agentId) ?? config.agents[0];
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
    [config, sessions, agentId],
  );

  const openAgent = useCallback(
    async (item: TriagedPull, prompt?: string, context?: string): Promise<void> => {
      if (me === null) return;
      await spawnAgent(
        item.pr.id,
        async (): Promise<string> => await ensureWorktree(item.pr),
        prompt ?? agentPrompt(item.pr, me),
        context,
      );
    },
    [me, spawnAgent, ensureWorktree],
  );

  /** Headless AI bound to a worktree; null when the selected agent has no headless command. */
  const aiIn = (cwdFor: () => Promise<string>): PrAi | null => {
    const agent = currentAgent();
    if (config === null || agent === undefined || agent.headless.trim() === "") return null;
    return {
      agentName: agent.name,
      run: async (prompt: string, context: string): Promise<string> =>
        await agentRun(await cwdFor(), config.workspaceDir, headlessCommand(agent, prompt), context),
    };
  };

  const aiFor = (pr: PullRequest): PrAi | null => aiIn(async (): Promise<string> => await ensureWorktree(pr));

  const analyze = async (item: TriagedPull, files: PrFile[]): Promise<void> => {
    const ai = aiFor(item.pr);
    const state = details[item.pr.id];
    if (ai === null) return;
    const id = item.pr.id;
    setAiStates((a) => ({ ...a, [id]: { status: "running" } }));
    try {
      const body = state?.status === "ready" ? state.detail.body : "";
      const output = await ai.run(REVIEW_PROMPT, diffContext(item.pr, body, files));
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

  const createTask = async (repo: string, branch: string, text: string): Promise<void> => {
    if (config === null) return;
    setNewTaskOpen(false);
    const repoUrl =
      pulls?.find((p): boolean => p.repo === repo)?.repoUrl ?? `https://${webHost(config.apiUrl)}/${repo}`;
    const id = `${TASK_PREFIX}${repo}:${branch}`;
    const task: Task = { id, repo, repoUrl, branch, text, cwd: null };
    saveTasks({ ...tasks, [id]: task });
    setView("board");
    navigate(id);
    const [owner = "", name = ""] = repo.split("/");
    await spawnAgent(
      id,
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

  const closeSession = async (prId: string): Promise<void> => {
    const s = sessions[prId];
    if (s?.status === "running") await ptyKill(s.sessionId);
    setSessions((all) => {
      const { [prId]: _removed, ...rest } = all;
      return rest;
    });
  };

  const saveSettings = async (next: Config): Promise<void> => {
    const saved = await saveConfig(next);
    setConfig(saved);
    if (!saved.agents.some((a): boolean => a.id === agentId)) setAgentId(saved.defaultAgentId);
    await checkToken();
    setView("board");
  };

  // Entering or leaving a PR morphs the row's title into the detail heading.
  const navigate = (id: string | null): void => {
    const crossing = (id === null) !== (selectedId === null);
    if (crossing) transition((): void => setSelectedId(id));
    else setSelectedId(id);
  };

  const unread = feed.filter((a): boolean => Date.parse(a.updatedAt) > feedSeenAt).length;

  const openFeed = (): void => setFeedOpen(true);

  const closeFeed = (): void => {
    setFeedOpen(false);
    setFeedSeenAt(Date.now());
  };

  // Feed items open in the app: from the board when the PR is there, otherwise fetched on their own.
  const pickActivity = async (a: Activity): Promise<void> => {
    closeFeed();
    if (a.number !== null) await openRef({ repo: a.repo, number: a.number });
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

  // Keyboard: j/k move, c agent, o GitHub, r refresh, n feed, "," settings, Esc back.
  const keyRef = useRef<(e: KeyboardEvent) => void>((): void => {});
  keyRef.current = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && view === "board") {
      e.preventDefault();
      setPaletteOpen(true);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || paletteOpen || feedOpen || newTaskOpen || dailyOpen || helpOpen) return;
    if (e.key === "Escape") {
      if (view !== "board" && hasToken === true) setView("board");
      else if (!isTyping(e.target)) navigate(null);
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
    if (e.key === "p") {
      setNewTaskOpen(true);
      return;
    }
    if (e.key === "t") {
      setView(view === "tree" ? "board" : "tree");
      return;
    }
    if (view !== "board") return;

    const index = ordered.findIndex((p): boolean => p.pr.id === selectedId);
    const step = (delta: number): void => {
      e.preventDefault();
      const next = ordered[Math.min(ordered.length - 1, Math.max(0, index === -1 ? 0 : index + delta))];
      if (next !== undefined) navigate(next.pr.id);
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
      case "c":
        if (selected !== null) void openAgent(selected);
        break;
      case "o":
        if (selected !== null) void openUrl(selected.pr.url);
        break;
      case "r":
        void refresh();
        if (selectedId !== null) void loadDetail(selectedId);
        break;
    }
  };

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
        async (): Promise<string> => cwd,
        contextPrompt("Continue the task below in this worktree. Do not commit or push."),
        `# Task\n\n${selectedTask.text}`,
      );
    }
  };
  const dockOpen = inDetail && session !== undefined;
  const mainClass = ["main", inDetail ? "is-detail" : "", dockOpen ? "has-dock" : ""].filter(Boolean).join(" ");

  return (
    <div className="app">
      <header className="band">
        <button
          type="button"
          className="wordmark"
          title="Voltar ao quadro"
          onClick={(): void => {
            setView("board");
            navigate(null);
          }}
        >
          prdesk
        </button>
        <button
          type="button"
          className={sync.error === null ? "band-sync" : "band-sync is-error"}
          onClick={(): void => void refresh()}
          disabled={sync.loading || hasToken !== true}
          title="Atualizar agora (R)"
          aria-live="polite"
        >
          <RefreshCw className={sync.loading ? "spin" : ""} size={14} strokeWidth={2} aria-hidden />
          {sync.loading
            ? "Sincronizando…"
            : sync.error !== null
              ? `Falha ao sincronizar: ${sync.error}`
              : sync.at !== null
                ? `Sincronizado às ${clock(sync.at)}`
                : "Atualizar"}
        </button>
        <div className="band-actions">
          <button
            type="button"
            className="band-search"
            title="Buscar PR (⌘K)"
            onClick={(): void => setPaletteOpen(true)}
          >
            <SearchIcon size={15} strokeWidth={2} aria-hidden /> <span className="band-label">Buscar PR</span>{" "}
            <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            className="text-button"
            title="Novidades (N)"
            onClick={openFeed}
            aria-label={unread > 0 ? `Novidades, ${unread} não lidas` : "Novidades"}
          >
            <Bell size={15} strokeWidth={2} aria-hidden /> <span className="band-label">Novidades</span>
            {unread > 0 && <span className="band-count">{unread}</span>}
          </button>
          {snoozedCount > 0 && (
            <button
              type="button"
              className="text-button"
              aria-pressed={showSnoozed}
              title={showSnoozed ? "Esconder as PRs adiadas" : "Mostrar as PRs adiadas no quadro"}
              onClick={(): void => setShowSnoozed(!showSnoozed)}
            >
              <Clock size={15} strokeWidth={2} aria-hidden /> <span className="band-label">Adiadas</span>{" "}
              <span className="band-count muted">{snoozedCount}</span>
            </button>
          )}
          {chains.length > 0 && (
            <button
              type="button"
              className="text-button"
              aria-pressed={view === "chains"}
              title="PRs ligadas por dependência, na ordem de merge"
              onClick={(): void => setView(view === "chains" ? "board" : "chains")}
            >
              <Link2 size={15} strokeWidth={2} aria-hidden /> <span className="band-label">Encadeadas</span>{" "}
              <span className="band-count muted">{chains.length}</span>
            </button>
          )}
          <button
            type="button"
            className="text-button"
            aria-pressed={view === "tree"}
            title="Árvore de branches de um repositório (T)"
            onClick={(): void => setView(view === "tree" ? "board" : "tree")}
          >
            <GitGraph size={15} strokeWidth={2} aria-hidden /> <span className="band-label">Árvore</span>
          </button>
          <button
            type="button"
            className="text-button"
            disabled={hasToken !== true}
            title="Resumo para a daily"
            onClick={(): void => setDailyOpen(true)}
          >
            <CalendarCheck size={15} strokeWidth={2} aria-hidden /> <span className="band-label">Daily</span>
          </button>
          <span className="band-rule" aria-hidden />
          <button
            type="button"
            className="icon-button"
            aria-label="Como usar (?)"
            title="Como usar (?)"
            onClick={(): void => setHelpOpen(true)}
          >
            <CircleHelp size={17} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Ajustes (,)"
            title={me === null ? "Ajustes (,)" : `Ajustes (,) · conectado como @${me}`}
            aria-current={view === "settings"}
            onClick={(): void => setView("settings")}
          >
            <SettingsIcon size={17} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            className="band-primary"
            title="Nova PR com agente (P)"
            disabled={hasToken !== true}
            onClick={(): void => setNewTaskOpen(true)}
          >
            <GitPullRequestCreate size={15} strokeWidth={2} aria-hidden /> <span className="band-label">Nova PR</span>{" "}
            <kbd>P</kbd>
          </button>
        </div>
      </header>

      {helpOpen && <HelpDialog onClose={(): void => setHelpOpen(false)} />}

      {feedOpen && (
        <Feed items={feed} seenAt={feedSeenAt} onPick={(a): void => void pickActivity(a)} onClose={closeFeed} />
      )}

      {newTaskOpen && (
        <NewTaskDialog
          repos={knownRepos}
          onClose={(): void => setNewTaskOpen(false)}
          onCreate={(repo, branch, text): void => void createTask(repo, branch, text)}
        />
      )}

      {dailyOpen && <DailyDialog config={config} waiting={groups.waiting} onClose={(): void => setDailyOpen(false)} />}

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

      <main className={mainClass}>
        {view === "settings" && (
          <Settings
            config={config}
            firstRun={hasToken !== true}
            onSave={saveSettings}
            onTokenChange={(): void => void checkToken()}
            onClose={(): void => setView("board")}
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

        {view === "tree" && (
          <TreeView pulls={pulls ?? []} onOpenPr={(repo, number): void => void openRef({ repo, number })} />
        )}

        {view === "board" && !inDetail && Object.keys(tasks).length > 0 && (
          <nav className="tasks-strip" aria-label="Tarefas em andamento">
            <span className="tasks-label">Em andamento</span>
            {Object.values(tasks).map(
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

        {view === "board" && !inDetail && (
          <Board
            groups={groups}
            deps={deps}
            loading={pulls === null}
            selectedId={null}
            rail={false}
            onSelect={navigate}
          />
        )}

        {inDetail && selectedTask !== undefined && selected === null && (
          <>
            <aside className="rail-wrap">
              <button type="button" className="back" onClick={(): void => navigate(null)}>
                <ArrowLeft size={20} strokeWidth={2.5} aria-hidden />
                <span>Voltar ao quadro</span>
                <kbd>Esc</kbd>
              </button>
              <Board groups={groups} deps={deps} loading={false} selectedId={null} rail onSelect={navigate} />
            </aside>
            <TaskView
              key={selectedTask.id}
              task={selectedTask}
              config={config}
              ai={selectedTask.cwd === null ? null : aiIn(async (): Promise<string> => selectedTask.cwd ?? "")}
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
                <ArrowLeft size={20} strokeWidth={2.5} aria-hidden />
                <span>Voltar ao quadro</span>
                <kbd>Esc</kbd>
              </button>
              <Board groups={groups} deps={deps} loading={false} selectedId={selectedId} rail onSelect={navigate} />
              <p className="rail-hint">
                <kbd>J</kbd> <kbd>K</kbd> para navegar
              </p>
            </aside>
            <Detail
              key={selected.pr.id}
              item={selected}
              me={me ?? ""}
              config={config}
              state={details[selected.pr.id] ?? { status: "loading" }}
              agents={config.agents}
              agentId={agentId}
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
              onAgentChange={setAgentId}
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
              />
            ) : null,
          )}
        </section>
      </main>
    </div>
  );
}
