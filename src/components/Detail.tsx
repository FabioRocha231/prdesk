import {
  ArrowUpRight,
  BellRing,
  Bot,
  Check,
  Clock,
  FileStack,
  GitMerge,
  GitPullRequestDraft,
  Pencil,
  Play,
  RefreshCcw,
  RotateCcw,
  Send,
  Sparkles,
  Swords,
  Tag,
  UserCog,
  UserPlus,
  UserRoundCheck,
  Wand2,
  XCircle,
} from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import { type AiRunner, IMPROVE_PROMPT, stripFence } from "../lib/ai";
import { type Agent, type Config, contextPrompt } from "../lib/config";
import { type DepLink, type Deps, isBlocked, type PrRef, refKey, shortRef } from "../lib/deps";
import { prFacts, sameLogin } from "../lib/facts";
import { age } from "../lib/format";
import {
  addComment,
  approve,
  closePull,
  convertToDraft,
  disableAutoMerge,
  editPull,
  enableAutoMerge,
  markReady,
  merge,
  requestReviewers,
  requestReviews,
  resolveThread,
  setAssignees,
  setLabels,
  updateBranch,
} from "../lib/github";
import { repoColor } from "../lib/holders";
import { errorMessage, rerunFailedJobs, saveCiLog } from "../lib/ipc";
import type { Comment, DraftComment, PrFile, PullDetail, PullRequest, Thread, TriagedPull } from "../lib/model";
import { type NextStep, nextStep } from "../lib/nextStep";
import { transitionName } from "./Board";
import { ChangesTab } from "./Changes";
import { ChecksTab, failedRunIds } from "./Checks";
import { blockers } from "./Daily";
import { PrTree } from "./GitTree";
import { Html } from "./Html";
import { Menu, type MenuItem } from "./Menu";
import { TurnBadge } from "./PrList";
import { type AiState, ReviewTab } from "./Review";
import { CommentView, htmlToText, isBotThread, PUSH_ROLES, type ReplyDrafter, ThreadsTab, waitsOnMe } from "./Threads";
import { useAction } from "./useAction";

// A merge is the one irreversible click here, so it takes a second click within this window.
const CONFIRM_WINDOW_MS = 4000;
const MAX_COMMENT = 65_000;
const MAX_TITLE = 256;

export type DetailState =
  | { status: "loading" }
  | { status: "ready"; detail: PullDetail }
  | { status: "error"; message: string };

type Tab = "files" | "threads" | "conversation" | "checks" | "tree" | "changes";

/** Opens the interactive agent; long instructions travel in `context` (written to `.prdesk/context.md`). */
export type OpenAgent = (prompt?: string, context?: string) => void;

export type SnoozeChoice = "tomorrow" | "monday" | "change" | "wake";

/** The AI helpers bound to this PR; null when the selected agent has no headless command. */
export interface PrAi {
  agentName: string;
  run: AiRunner;
}

const REVIEW_NOTE: Record<string, string> = {
  APPROVED: "aprovou",
  CHANGES_REQUESTED: "pediu mudanças",
  COMMENTED: "revisou",
  DISMISSED: "review descartado",
};

const MERGE_LABEL: Record<string, string> = { SQUASH: "squash", REBASE: "rebase", MERGE: "merge commit" };

// Labels and assignees need at least triage access; GitHub rejects the edit below that.
const TRIAGE_ROLES = new Set(["TRIAGE", ...PUSH_ROLES]);

/** The inline list editors under the action bar: who reviews, which labels, who is assigned. */
type ListEdit = "reviewers" | "labels" | "assignees";

const LIST_EDIT: Record<ListEdit, { label: string; placeholder: string; submit: string }> = {
  reviewers: { label: "Logins de quem deve revisar", placeholder: "@login, @outro", submit: "Pedir review" },
  labels: { label: "Labels da PR, separadas por vírgula", placeholder: "bug, needs-qa", submit: "Salvar labels" },
  assignees: { label: "Responsáveis pela PR", placeholder: "@login, @outro", submit: "Salvar responsáveis" },
};

const logins = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((l): string => l.replace(/^@/, ""))
    .filter((l): boolean => /^[A-Za-z0-9-]+$/.test(l));

const labelList = (text: string): string[] =>
  text
    .split(",")
    .map((l): string => l.trim())
    .filter(Boolean);

function ConversationTab({
  config,
  prId,
  prAuthor,
  me,
  detail,
  focusId,
  onChanged,
}: {
  config: Config;
  prId: string;
  focusId: string | null;
  prAuthor: string | null;
  me: string;
  detail: PullDetail;
  onChanged: () => void;
}): ReactElement {
  const [body, setBody] = useState("");
  const action = useAction();
  const send = async (): Promise<void> => {
    if (await action.run("comment", async (): Promise<void> => await addComment(config, prId, body.trim()))) {
      setBody("");
      onChanged();
    }
  };
  const people = detail.timeline.filter((c): boolean => !c.isBot);
  const bots = detail.timeline.filter((c): boolean => c.isBot);
  const view = (c: (typeof detail.timeline)[number]): ReactElement => (
    <CommentView
      key={c.id}
      comment={c}
      prAuthor={prAuthor}
      me={me}
      focused={c.id === focusId}
      {...(c.reviewState === null ? {} : { note: REVIEW_NOTE[c.reviewState] ?? "" })}
    />
  );
  return (
    <div className="timeline">
      {people.length === 0 && <p className="notice">Sem comentários de pessoas.</p>}
      {people.map(view)}
      {bots.length > 0 && (
        <details className="fold" open={bots.some((c): boolean => c.id === focusId) || undefined}>
          <summary>
            Comentários de bots <b>{bots.length}</b>
          </summary>
          {bots.map(view)}
        </details>
      )}
      <div className="reply standalone">
        <textarea
          className="input"
          rows={3}
          maxLength={MAX_COMMENT}
          placeholder="Comentar na PR… (⌘↵ envia)"
          value={body}
          onChange={(e): void => setBody(e.target.value)}
          onKeyDown={(e): void => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim() !== "") void send();
          }}
        />
        <div className="reply-actions">
          <button
            type="button"
            className="button primary small"
            disabled={body.trim() === "" || action.pending !== null}
            onClick={(): void => void send()}
          >
            <Send size={14} strokeWidth={2} aria-hidden /> {action.pending === "comment" ? "Enviando…" : "Comentar"}
          </button>
          {action.error !== null && (
            <span className="action-error" role="alert">
              {action.error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function DescriptionTab({
  config,
  item,
  detail,
  me,
  ai,
  onChanged,
}: {
  config: Config;
  item: TriagedPull;
  detail: PullDetail;
  me: string;
  ai: PrAi | null;
  onChanged: () => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(detail.body);
  const action = useAction();
  const { pr } = item;

  const improve = async (): Promise<void> => {
    if (ai === null) return;
    await action.run("improve", async (): Promise<void> => {
      setBody(stripFence(await ai.run(IMPROVE_PROMPT, `# ${pr.repo}#${pr.number}: ${pr.title}\n\n${body}`)));
    });
  };

  const save = async (): Promise<void> => {
    if (await action.run("save", async (): Promise<void> => await editPull(config, pr, { body }))) {
      setEditing(false);
      onChanged();
    }
  };

  if (!editing) {
    return (
      <div className="description">
        {pr.author === me && (
          <div className="desc-actions">
            <button
              type="button"
              className="chip-button"
              onClick={(): void => {
                setBody(detail.body);
                setEditing(true);
              }}
            >
              <Pencil size={14} strokeWidth={2} aria-hidden /> Editar descrição
            </button>
          </div>
        )}
        {detail.bodyHTML.trim() === "" ? <p className="notice">Sem descrição.</p> : <Html html={detail.bodyHTML} />}
      </div>
    );
  }
  return (
    <div className="description">
      <textarea
        className="input desc-editor"
        rows={16}
        maxLength={MAX_COMMENT}
        value={body}
        onChange={(e): void => setBody(e.target.value)}
      />
      <div className="reply-actions">
        <button
          type="button"
          className="button primary small"
          disabled={action.pending !== null}
          onClick={(): void => void save()}
        >
          {action.pending === "save" ? "Salvando…" : "Salvar no GitHub"}
        </button>
        {ai !== null && (
          <button
            type="button"
            className="chip-button accent"
            disabled={action.pending !== null}
            onClick={(): void => void improve()}
          >
            <Wand2 size={14} strokeWidth={2} aria-hidden />
            {action.pending === "improve" ? "Reescrevendo…" : `Melhorar com ${ai.agentName}`}
          </button>
        )}
        <button type="button" className="text-button" onClick={(): void => setEditing(false)}>
          Cancelar
        </button>
        {action.error !== null && (
          <span className="action-error" role="alert">
            {action.error}
          </span>
        )}
      </div>
    </div>
  );
}

interface Action {
  key: string;
  label: string;
  icon: ReactElement;
  tone?: "accent" | "good" | "danger";
  run: () => void;
}

/**
 * One obvious next step for this PR (from `nextStep`) as the primary button; every other action that applies
 * lives in the "Mais" menu, so the header never shows a wall of equal buttons.
 */
function ActionBar({
  config,
  item,
  detail,
  me,
  drafts,
  onFilesTab,
  agentBlocked,
  blocked,
  snoozed,
  onOpenAgent,
  onOpenGithub,
  onShowFiles,
  onSnooze,
  onChanged,
  approved,
  onApproved,
  extra,
}: {
  config: Config;
  item: TriagedPull;
  detail: PullDetail | null;
  me: string;
  drafts: number;
  onFilesTab: boolean;
  agentBlocked: boolean;
  /** A declared dependency is still open, so merging now would land out of order. */
  blocked: boolean;
  snoozed: boolean;
  onOpenAgent: OpenAgent;
  onOpenGithub: () => void;
  onShowFiles: () => void;
  onSnooze: (choice: SnoozeChoice) => void;
  onChanged: () => void;
  /** I approved the PR, on GitHub or a moment ago in this view. */
  approved: boolean;
  onApproved: () => void;
  /** Items the caller adds to the menu, such as switching agents. */
  extra: MenuItem[];
}): ReactElement {
  const action = useAction();
  const [confirm, setConfirm] = useState<"merge" | "close" | null>(null);
  const [editing, setEditing] = useState<ListEdit | null>(null);
  const [listText, setListText] = useState("");
  const { pr } = item;
  const mine = pr.author === me;
  const closed = pr.closed !== undefined;
  const [owner = "", repo = ""] = pr.repo.split("/");
  const runs = detail === null ? [] : failedRunIds(detail.checks);
  const failing = detail?.checks.filter((c): boolean => c.state === "failure") ?? [];
  const waiting = detail?.threads.filter((t): boolean => waitsOnMe(t, me, mine) && !isBotThread(t)) ?? [];
  const mergeReady = mine && pr.reviewDecision === "APPROVED" && !pr.isDraft && detail?.mergeable === "MERGEABLE";
  const mergeLabel = MERGE_LABEL[detail?.mergeMethod ?? ""] ?? detail?.mergeMethod ?? "";
  // Changes were requested, I pushed after them, and the reviewer has not been asked to look again.
  const facts = prFacts(pr, me);
  const rereview = facts.askAgain.length > 0;
  const nudgeable = pr.requestedReviewers.filter((l): boolean => !sameLogin(l, me));
  const stale =
    mine && item.triage.column === "waiting" && nudgeable.length > 0 && blockers([item], Date.now()).length > 0;
  const nudgeText = `${nudgeable.map((l): string => `@${l}`).join(" ")}, consegue dar uma olhada nesta PR quando puder?`;

  useEffect((): (() => void) | undefined => {
    if (confirm === null) return undefined;
    const timer = window.setTimeout((): void => setConfirm(null), CONFIRM_WINDOW_MS);
    return (): void => window.clearTimeout(timer);
  }, [confirm]);

  const startEdit = (kind: ListEdit): void => {
    setEditing(kind);
    if (kind === "labels") setListText(detail?.labels.map((l): string => l.name).join(", ") ?? "");
    else if (kind === "assignees") setListText(detail?.assignees.map((l): string => `@${l}`).join(", ") ?? "");
    else setListText("");
  };

  const act = (key: string, fn: () => Promise<void>): void => {
    void (async (): Promise<void> => {
      if (await action.run(key, fn)) onChanged();
    })();
  };

  // One agent run for everything that is my turn: waiting threads plus failing CI (with their logs).
  const autopilot = (): void => {
    void action.run("autopilot", async (): Promise<void> => {
      const parts = [`# Fix everything pending on ${pr.url}`, ""];
      for (const t of waiting) {
        parts.push(`## Review thread on ${t.path}${t.line === null ? "" : `:${t.line}`}`);
        for (const c of t.comments) parts.push(`**${c.author}:** ${htmlToText(c.bodyHTML)}`);
        parts.push("");
      }
      for (const c of failing) {
        if (c.jobId === null) {
          parts.push(`## Failing check: ${c.name} (no log available)`, "");
          continue;
        }
        const log = await saveCiLog(config.apiUrl, owner, repo, c.jobId, config.workspaceDir);
        parts.push(`## Failing check: ${c.name}`, `Log tail: ${log}`, "");
      }
      onOpenAgent(
        contextPrompt(
          `Address every open review thread and fix every failing CI check of pull request ${pr.url} in this worktree, then run the relevant tests. Summarize the change per thread so I can answer the reviewers. Do not push.`,
        ),
        parts.join("\n"),
      );
    });
  };

  // What other people raised that is still open: unresolved threads plus the PR conversation.
  const feedback = [
    ...(detail?.threads ?? [])
      .filter((t): boolean => !t.isResolved && t.comments.some((c): boolean => !sameLogin(c.author, me)))
      .map((t): string =>
        [
          `## Review thread on ${t.path}${t.line === null ? "" : `:${t.line}`}`,
          ...t.comments.map((c): string => `**${c.author}:** ${htmlToText(c.bodyHTML)}`),
        ].join("\n"),
      ),
    ...(detail?.timeline ?? [])
      .filter((c): boolean => !c.isBot && !sameLogin(c.author, me))
      .map((c): string => `## Conversation comment by ${c.author} (${c.createdAt})\n${htmlToText(c.bodyHTML)}`),
  ];
  const applyFeedback = (): void =>
    onOpenAgent(
      contextPrompt(
        `Go through the reviewer feedback on pull request ${pr.url} and check each point against the code in this worktree before touching anything. Fix only the points that hold; for the ones already done, outdated or wrong, change nothing and say why. When a point is a decision for me (an order, a trade-off, scope), do not decide it: list it as a question. When the description is asked to change, propose the new text. Run the relevant tests, then summarize per point: applied, skipped (why) or needs my decision. Do not push.`,
      ),
      [`# Reviewer feedback on ${pr.url}`, "", "## Current description", detail?.body ?? "", "", ...feedback].join(
        "\n\n",
      ),
    );

  const actions: Record<Exclude<NextStep, null>, Action> = {
    "send-review": {
      key: "send-review",
      label: `Enviar review (${drafts})`,
      icon: <Send size={15} strokeWidth={2} aria-hidden />,
      tone: "accent",
      run: onShowFiles,
    },
    "review-files": {
      key: "review-files",
      label: "Revisar arquivos",
      icon: <FileStack size={15} strokeWidth={2} aria-hidden />,
      tone: "accent",
      run: onShowFiles,
    },
    conflicts: {
      key: "conflicts",
      label: "Resolver conflitos com agente",
      icon: <Swords size={15} strokeWidth={2} aria-hidden />,
      tone: "danger",
      run: (): void =>
        onOpenAgent(
          `This branch (${pr.headRef}) conflicts with ${pr.baseRef}. The base is already fetched: run git merge origin/${pr.baseRef} in this worktree, resolve every conflict keeping the intent of both sides, run the tests and commit the merge. Do not push.`,
        ),
    },
    autopilot: {
      key: "autopilot",
      label: `Resolver tudo com agente (${waiting.length + failing.length})`,
      icon: <Bot size={15} strokeWidth={2} aria-hidden />,
      tone: "accent",
      run: autopilot,
    },
    merge: {
      key: "merge",
      label: `Merge (${mergeLabel})`,
      icon: <GitMerge size={15} strokeWidth={2} aria-hidden />,
      tone: "good",
      run: (): void => setConfirm("merge"),
    },
    ready: {
      key: "ready",
      label: "Marcar como pronta",
      icon: <Check size={15} strokeWidth={2} aria-hidden />,
      tone: "good",
      run: (): void => act("ready", async (): Promise<void> => await markReady(config, pr.id)),
    },
    "update-branch": {
      key: "update-branch",
      label: "Atualizar branch",
      icon: <RefreshCcw size={15} strokeWidth={2} aria-hidden />,
      run: (): void => act("update-branch", async (): Promise<void> => await updateBranch(config, pr)),
    },
    rereview: {
      key: "rereview",
      label: "Pedir novo review",
      icon: <UserRoundCheck size={15} strokeWidth={2} aria-hidden />,
      tone: "accent",
      run: (): void =>
        act("rereview", async (): Promise<void> => await requestReviews(config, pr.id, detail?.reviewerIds ?? [])),
    },
    nudge: {
      key: "nudge",
      label: `Cutucar ${nudgeable.map((l): string => `@${l}`).join(", ")}`,
      icon: <BellRing size={15} strokeWidth={2} aria-hidden />,
      run: (): void => act("nudge", async (): Promise<void> => await addComment(config, pr.id, nudgeText)),
    },
  };

  const step = nextStep({
    mine,
    closed,
    conflicting: detail?.mergeable === "CONFLICTING",
    pending: waiting.length + failing.length,
    mergeReady: mergeReady === true,
    draft: pr.isDraft,
    behind: detail?.mergeState === "BEHIND",
    blocked,
    drafts,
    approved,
    onFilesTab,
    rereview: rereview && (detail?.reviewerIds.length ?? 0) > 0,
    stale,
  });
  const primary = step === null ? null : actions[step];

  // Everything else that applies goes into the menu, grouped by what it touches.
  const menu: MenuItem[] = [];
  const add = (group: string, a: Action, enabled = true): void => {
    if (a.key === primary?.key) return;
    menu.push({
      key: a.key,
      label: a.label,
      icon: a.icon,
      group,
      disabled: !enabled,
      onSelect: a.run,
      ...(a.tone === "danger" ? { tone: "danger" as const } : {}),
    });
  };
  if (!closed && detail !== null) {
    if (mine && (waiting.length > 0 || failing.length > 0)) add("pr", actions.autopilot, !agentBlocked);
    if (mine && feedback.length > 0)
      add(
        "pr",
        {
          key: "apply-feedback",
          label: `Aplicar comentários com IA (${feedback.length})`,
          icon: <Wand2 size={15} strokeWidth={2} aria-hidden />,
          run: applyFeedback,
        },
        !agentBlocked,
      );
    if (detail.mergeable === "CONFLICTING") add("pr", actions.conflicts, !agentBlocked);
    if (mergeReady) add("pr", actions.merge);
    // Approved-but-waiting PRs merge themselves once CI passes, so nobody has to come back for them.
    // GitHub refuses it when the repo disallows auto-merge, or when the PR is already mergeable (CLEAN) or conflicting.
    const canAutoMerge =
      detail.autoMergeAllowed &&
      detail.mergeState !== "CLEAN" &&
      detail.mergeable !== "CONFLICTING" &&
      !pr.isDraft &&
      !mergeReady &&
      !blocked;
    if (mine && detail.autoMerge)
      add("pr", {
        key: "auto-merge-off",
        label: "Cancelar auto-merge",
        icon: <GitMerge size={15} strokeWidth={2} aria-hidden />,
        run: (): void => act("auto-merge-off", async (): Promise<void> => await disableAutoMerge(config, pr.id)),
      });
    else if (mine && canAutoMerge)
      add("pr", {
        key: "auto-merge",
        label: `Mergear quando o CI passar (${mergeLabel})`,
        icon: <GitMerge size={15} strokeWidth={2} aria-hidden />,
        run: (): void =>
          act("auto-merge", async (): Promise<void> => await enableAutoMerge(config, pr.id, detail.mergeMethod)),
      });
    if (detail.mergeState === "BEHIND") add("pr", actions["update-branch"]);
    if (!mine && !approved)
      add("pr", {
        key: "approve",
        label: "Aprovar sem comentários",
        icon: <Check size={15} strokeWidth={2} aria-hidden />,
        run: (): void =>
          act("approve", async (): Promise<void> => {
            await approve(config, pr.id);
            onApproved();
          }),
      });
    if (mine && pr.isDraft) add("pr", actions.ready);
    if (mine && !pr.isDraft)
      add("pr", {
        key: "to-draft",
        label: "Voltar para rascunho",
        icon: <GitPullRequestDraft size={15} strokeWidth={2} aria-hidden />,
        run: (): void => act("to-draft", async (): Promise<void> => await convertToDraft(config, pr.id)),
      });
    if (mine && detail.reviewerIds.length > 0 && pr.reviewDecision !== "APPROVED") add("people", actions.rereview);
    if (mine)
      add("people", {
        key: "ask",
        label: "Pedir review de alguém…",
        icon: <UserPlus size={15} strokeWidth={2} aria-hidden />,
        run: (): void => startEdit("reviewers"),
      });
    if (mine && nudgeable.length > 0) add("people", actions.nudge);
    if (TRIAGE_ROLES.has(detail.permission)) {
      add("people", {
        key: "assignees",
        label: "Responsáveis…",
        icon: <UserCog size={15} strokeWidth={2} aria-hidden />,
        run: (): void => startEdit("assignees"),
      });
      add("people", {
        key: "labels",
        label: "Labels…",
        icon: <Tag size={15} strokeWidth={2} aria-hidden />,
        run: (): void => startEdit("labels"),
      });
    }
    if (runs.length > 0)
      add("pr", {
        key: "rerun",
        label: "Re-rodar o CI que falhou",
        icon: <RotateCcw size={15} strokeWidth={2} aria-hidden />,
        run: (): void =>
          act("rerun", async (): Promise<void> => {
            for (const runId of runs) await rerunFailedJobs(config.apiUrl, owner, repo, runId);
          }),
      });
  }
  if (!closed) {
    const clock = <Clock size={15} strokeWidth={2} aria-hidden />;
    if (snoozed)
      add("later", { key: "wake", label: "Trazer de volta agora", icon: clock, run: (): void => onSnooze("wake") });
    add("later", {
      key: "tomorrow",
      label: "Adiar até amanhã, 9h",
      icon: clock,
      run: (): void => onSnooze("tomorrow"),
    });
    add("later", { key: "monday", label: "Adiar até segunda, 9h", icon: clock, run: (): void => onSnooze("monday") });
    add("later", { key: "change", label: "Adiar até ela mudar", icon: clock, run: (): void => onSnooze("change") });
  }
  if (!closed && (mine || PUSH_ROLES.has(detail?.permission ?? "")))
    add("close", {
      key: "close",
      label: "Fechar sem mergear",
      icon: <XCircle size={15} strokeWidth={2} aria-hidden />,
      tone: "danger",
      run: (): void => setConfirm("close"),
    });
  menu.push(...extra);
  add("out", {
    key: "github",
    label: "Abrir no GitHub (O)",
    icon: <ArrowUpRight size={15} strokeWidth={2} aria-hidden />,
    run: onOpenGithub,
  });

  const entries = editing === "labels" ? labelList(listText) : logins(listText);
  // Saving an empty label or assignee list clears it; an empty review request does nothing.
  const canSave = editing !== "reviewers" || entries.length > 0;
  const saveList = (): void => {
    if (editing === null || !canSave) return;
    const kind = editing;
    act(kind, async (): Promise<void> => {
      if (kind === "reviewers") await requestReviewers(config, pr, entries);
      else if (kind === "labels") await setLabels(config, pr, entries);
      else await setAssignees(config, pr, entries);
      setEditing(null);
      setListText("");
    });
  };

  return (
    <div className="action-bar">
      {confirm === "merge" && detail !== null ? (
        <button
          type="button"
          className="step-button danger"
          disabled={action.pending !== null}
          onClick={(): void => {
            setConfirm(null);
            act("merge", async (): Promise<void> => await merge(config, pr.id, detail.mergeMethod));
          }}
        >
          <GitMerge size={15} strokeWidth={2} aria-hidden /> Confirmar merge ({mergeLabel})?
        </button>
      ) : confirm === "close" ? (
        <button
          type="button"
          className="step-button danger"
          disabled={action.pending !== null}
          onClick={(): void => {
            setConfirm(null);
            act("close", async (): Promise<void> => await closePull(config, pr));
          }}
        >
          <XCircle size={15} strokeWidth={2} aria-hidden /> Confirmar: fechar sem mergear?
        </button>
      ) : (
        primary !== null && (
          <button
            type="button"
            className={`step-button ${primary.tone ?? ""}`}
            disabled={action.pending !== null || (primary.key === "autopilot" && agentBlocked)}
            onClick={primary.run}
          >
            {primary.icon}
            {action.pending === primary.key ? "Aguarde…" : primary.label}
          </button>
        )
      )}
      <Menu label="Mais" items={menu} />
      {editing !== null && (
        <form
          className="ask-review"
          onSubmit={(e): void => {
            e.preventDefault();
            saveList();
          }}
        >
          <input
            className="input"
            // biome-ignore lint/a11y/noAutofocus: opens on an explicit menu choice
            autoFocus
            aria-label={LIST_EDIT[editing].label}
            placeholder={LIST_EDIT[editing].placeholder}
            {...(editing === "labels" ? { list: "repo-labels" } : {})}
            value={listText}
            onChange={(e): void => setListText(e.target.value)}
            onKeyDown={(e): void => {
              if (e.key === "Escape") setEditing(null);
            }}
          />
          {editing === "labels" && (
            <datalist id="repo-labels">
              {(detail?.repoLabels ?? []).map(
                (l): ReactElement => (
                  // Offers each label appended to what is already typed, so a comma list still autocompletes.
                  <option
                    key={l}
                    value={listText.includes(",") ? `${listText.replace(/[^,]*$/, " ").trimEnd()} ${l}` : l}
                  />
                ),
              )}
            </datalist>
          )}
          <button type="submit" className="button small" disabled={!canSave || action.pending !== null}>
            {action.pending === editing ? "Salvando…" : LIST_EDIT[editing].submit}
          </button>
        </form>
      )}
      {action.pending !== null && action.pending !== primary?.key && (
        <span className="action-busy pulse" role="status">
          Aguarde…
        </span>
      )}
      {action.error !== null && (
        <span className="action-error" role="alert">
          {action.error}
        </span>
      )}
    </div>
  );
}

function TitleEditor({
  config,
  item,
  onDone,
}: {
  config: Config;
  item: TriagedPull;
  onDone: (changed: boolean) => void;
}): ReactElement {
  const [title, setTitle] = useState(item.pr.title);
  const action = useAction();
  const save = async (): Promise<void> => {
    const next = title.trim();
    if (next === "" || next === item.pr.title) {
      onDone(false);
      return;
    }
    if (await action.run("title", async (): Promise<void> => await editPull(config, item.pr, { title: next }))) {
      onDone(true);
    }
  };
  return (
    <form
      className="title-edit"
      onSubmit={(e): void => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        className="input"
        // biome-ignore lint/a11y/noAutofocus: opens on an explicit click on the pencil
        autoFocus
        aria-label="Título da PR"
        maxLength={MAX_TITLE}
        value={title}
        onChange={(e): void => setTitle(e.target.value)}
        onKeyDown={(e): void => {
          if (e.key === "Escape") onDone(false);
        }}
      />
      <button type="submit" className="button primary small" disabled={action.pending !== null}>
        {action.pending === "title" ? "Salvando…" : "Salvar"}
      </button>
      {action.error !== null && (
        <span className="action-error" role="alert">
          {action.error}
        </span>
      )}
    </form>
  );
}

function ChainNode({ link, onOpen }: { link: DepLink; onOpen: (ref: PrRef) => void }): ReactElement {
  const open = link.pr !== null;
  return (
    <button
      type="button"
      className={`chain-node ${open ? "is-open" : "is-done"}`}
      title={
        open ? `${link.repo}#${link.number} · aberta` : "Fora do quadro: mergeada, fechada ou fora dos seus escopos"
      }
      onClick={(): void => onOpen(link)}
    >
      <span className="chain-dot" aria-hidden />
      {shortRef(link)}
    </button>
  );
}

/** "core#605 → this → web#12": what has to merge first and what waits on this PR. */
function DepChain({
  pr,
  deps,
  onOpen,
}: {
  pr: PullRequest;
  deps: Deps;
  onOpen: (ref: PrRef) => void;
}): ReactElement | null {
  if (deps.blockedBy.length === 0 && deps.blocks.length === 0) return null;
  const waiting = deps.blockedBy.some((d): boolean => d.pr !== null);
  return (
    <nav className="chain" aria-label="Dependências">
      <span>{waiting ? "Mergear depois de" : "Ordem de merge"}</span>
      {deps.blockedBy.map(
        (d): ReactElement => (
          <ChainNode key={refKey(d)} link={d} onOpen={onOpen} />
        ),
      )}
      {deps.blockedBy.length > 0 && <span aria-hidden>→</span>}
      <span className="chain-node is-self" aria-current="true">
        <span className="chain-dot" aria-hidden />
        {shortRef(pr)} (esta)
      </span>
      {deps.blocks.length > 0 && <span aria-hidden>→</span>}
      {deps.blocks.map(
        (d): ReactElement => (
          <ChainNode key={refKey(d)} link={d} onOpen={onOpen} />
        ),
      )}
    </nav>
  );
}

export function Detail({
  item,
  state,
  me,
  config,
  agents,
  agentId,
  agentBusy,
  agentBlocked,
  worktree,
  drafts,
  aiState,
  ai,
  draftReply,
  snoozed,
  deps,
  repoPulls,
  onOpenRef,
  onAgentChange,
  onOpenAgent,
  onOpenGithub,
  onDrafts,
  onAnalyze,
  focusComment,
  onFocused,
  onSnooze,
  onChanged,
}: {
  item: TriagedPull;
  state: DetailState;
  me: string;
  config: Config;
  agents: Agent[];
  agentId: string;
  agentBusy: boolean;
  /** A session is already open for this PR; a second agent would fight over the same worktree. */
  agentBlocked: boolean;
  /** The PR's worktree once an agent has been opened, for the "Mudanças" tab. */
  worktree: string | null;
  drafts: DraftComment[];
  aiState: AiState;
  ai: PrAi | null;
  draftReply: ReplyDrafter;
  snoozed: boolean;
  deps: Deps;
  /** Open PRs in the same repo, for stacked branches in the tree. */
  repoPulls: PullRequest[];
  onOpenRef: (ref: PrRef) => void;
  onAgentChange: (id: string) => void;
  onOpenAgent: OpenAgent;
  onOpenGithub: () => void;
  onDrafts: (next: DraftComment[]) => void;
  onAnalyze: (files: PrFile[]) => void;
  onSnooze: (choice: SnoozeChoice) => void;
  /** Database id of a comment to open the PR on, from Novidades; `onFocused` once it is shown. */
  focusComment: number | null;
  onFocused: () => void;
  onChanged: () => void;
}): ReactElement {
  const { pr, triage } = item;
  const prIsMine = pr.author === me;
  // Reviewing someone else's PR starts on the diff; my own PR starts on the code comments about it, or on the
  // conversation when what brought me here is a comment there.
  const [tab, setTab] = useState<Tab>(triage.kind === "comment" ? "conversation" : prIsMine ? "threads" : "files");
  const [editingTitle, setEditingTitle] = useState(false);
  const agent = agents.find((a): boolean => a.id === agentId) ?? agents[0];
  // What I resolve or approve here shows at once; the refetch onChanged starts confirms it a few seconds later.
  const [resolvedHere, setResolvedHere] = useState<ReadonlySet<string>>(new Set());
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [approvedHere, setApprovedHere] = useState(false);
  const loaded = state.status === "ready" ? state.detail : null;
  const detail = useMemo(
    (): PullDetail | null =>
      loaded === null || resolvedHere.size === 0
        ? loaded
        : {
            ...loaded,
            threads: loaded.threads.map((t): Thread => (resolvedHere.has(t.id) ? { ...t, isResolved: true } : t)),
          },
    [loaded, resolvedHere],
  );
  // An approval older than the last commit does not cover the new code (facts.ts): approving again is a real choice.
  const approved = approvedHere || prFacts(pr, me).myApprovalHolds;
  const resolve = async (thread: Thread): Promise<void> => {
    setResolveError(null);
    setResolvedHere((s): ReadonlySet<string> => new Set(s).add(thread.id));
    try {
      await resolveThread(config, thread.id);
      onChanged();
    } catch (e) {
      setResolvedHere((s): ReadonlySet<string> => {
        const next = new Set(s);
        next.delete(thread.id);
        return next;
      });
      setResolveError(`Não deu para resolver a conversa em ${thread.path}: ${errorMessage(e)}`);
    }
  };
  // A cached detail can predate the comment, so the focus waits until a detail that holds it loads.
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect((): void => {
    if (focusComment === null || detail === null) return;
    const holds = (c: Comment): boolean => c.databaseId === focusComment;
    const thread = detail.threads.find((t): boolean => t.comments.some(holds));
    const target = (thread?.comments ?? detail.timeline).find(holds);
    if (target === undefined) return;
    setTab(thread === undefined ? "conversation" : "threads");
    setFocusId(target.id);
    onFocused();
  }, [focusComment, detail, onFocused]);
  const openThreads = detail?.threads.filter((t): boolean => !t.isResolved) ?? [];
  const waitingIds = openThreads.filter((t): boolean => waitsOnMe(t, me, prIsMine)).map((t): string => t.id);
  const failing = detail?.checks.filter((c): boolean => c.state === "failure").length ?? 0;

  const tabs: { id: Tab; label: string; count: number | null; alert?: string }[] = [
    {
      id: "files",
      label: "Arquivos",
      count: detail?.changedFiles ?? null,
      ...(drafts.length > 0 ? { alert: `${drafts.length} no rascunho` } : {}),
    },
    {
      id: "threads",
      label: "Comentários",
      count: detail === null ? null : openThreads.length,
      ...(waitingIds.length > 0 ? { alert: `${waitingIds.length} esperando você` } : {}),
    },
    {
      id: "conversation",
      label: "Conversa",
      count: detail?.timeline.length ?? null,
      ...(triage.kind === "comment" ? { alert: "comentário novo" } : {}),
    },
    {
      id: "checks",
      label: "CI",
      count: detail?.checks.length ?? null,
      ...(failing > 0 ? { alert: `${failing} falhando` } : {}),
    },
    { id: "tree", label: "Árvore", count: null },
    ...(worktree === null ? [] : [{ id: "changes" as const, label: "Mudanças locais", count: null }]),
  ];

  return (
    <article className={`detail poster-${triage.column}`} aria-label={`PR ${pr.number}`}>
      <header className="dhead">
        <div className="dhead-trail">
          <span className="dhead-repo">
            <span className="pl-dot" style={{ background: repoColor(pr.repo) }} aria-hidden />
            {pr.repo} <span className="dhead-number">#{pr.number}</span>
          </span>
          <span className="dhead-branch">
            {pr.author ?? "ghost"} → {pr.headRef}
          </span>
          {detail?.labels.map(
            (l): ReactElement => (
              <span key={l.name} className="dhead-label" style={{ ["--label" as string]: `#${l.color}` }}>
                {l.name}
              </span>
            ),
          )}
          {detail !== null && (
            <span className="dhead-stats">
              <b className="tone-add">+{detail.additions}</b>
              <b className="tone-del">−{detail.deletions}</b>
              <span>{detail.changedFiles} arquivos</span>
            </span>
          )}
        </div>

        <div className="dhead-main">
          {editingTitle ? (
            <TitleEditor
              config={config}
              item={item}
              onDone={(changed): void => {
                setEditingTitle(false);
                if (changed) onChanged();
              }}
            />
          ) : (
            <h1 className="dhead-title" style={{ viewTransitionName: transitionName("title", pr.id) }}>
              {pr.title}
              {prIsMine && pr.closed === undefined && (
                <button
                  type="button"
                  className="title-pencil"
                  aria-label="Editar título"
                  title="Editar título"
                  onClick={(): void => setEditingTitle(true)}
                >
                  <Pencil size={15} strokeWidth={2} aria-hidden />
                </button>
              )}
            </h1>
          )}
        </div>

        <div className="dhead-bar">
          {pr.closed === undefined ? (
            <TurnBadge kind={triage.kind} />
          ) : (
            <span className="turn">{pr.closed === "MERGED" ? "Mergeada" : "Fechada"}</span>
          )}
          <span className="dhead-signal">
            {triage.actor !== null && <b>{triage.actor} </b>}
            {triage.reason}
            {triage.at !== null && <span className="dhead-age"> · {age(triage.at)}</span>}
          </span>
          {snoozed && <span className="dhead-snoozed">adiada</span>}
          {detail?.autoMerge === true && <span className="dhead-automerge">auto-merge ligado</span>}
          <div className="dhead-actions">
            <ActionBar
              approved={approved}
              onApproved={(): void => setApprovedHere(true)}
              config={config}
              item={item}
              detail={detail}
              me={me}
              drafts={drafts.length}
              onFilesTab={tab === "files"}
              agentBlocked={agentBlocked}
              blocked={isBlocked(deps)}
              snoozed={snoozed}
              onOpenAgent={onOpenAgent}
              onOpenGithub={onOpenGithub}
              onShowFiles={(): void => setTab("files")}
              onSnooze={onSnooze}
              onChanged={onChanged}
              extra={agents
                .filter((a): boolean => a.id !== agentId)
                .map(
                  (a): MenuItem => ({
                    key: `agent-${a.id}`,
                    label: `Usar o ${a.name}`,
                    icon: <Bot size={15} strokeWidth={2} aria-hidden />,
                    group: "agent",
                    onSelect: (): void => onAgentChange(a.id),
                  }),
                )}
            />
            <div className="agent-pick">
              <button type="button" onClick={(): void => onOpenAgent()} disabled={agentBusy}>
                <Play size={15} strokeWidth={2.5} aria-hidden />
                {agentBusy ? "Preparando…" : `Abrir no ${agent?.name ?? "agente"}`}
                <kbd>C</kbd>
              </button>
            </div>
          </div>
        </div>

        <DepChain pr={pr} deps={deps} onOpen={onOpenRef} />

        <div className="tabs" role="tablist" aria-label="Seções da PR">
          {tabs.map(
            (t): ReactElement => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className="tab"
                onClick={(): void => setTab(t.id)}
              >
                {t.label}
                {t.count !== null && <span className="tab-count">{t.count}</span>}
                {t.alert !== undefined && <span className="tab-alert">{t.alert}</span>}
              </button>
            ),
          )}
          {aiState.status === "running" && (
            <span className="tab-ai pulse">
              <Sparkles size={13} strokeWidth={2} aria-hidden /> IA analisando
            </span>
          )}
        </div>
      </header>

      <div className="detail-body" role="tabpanel">
        {state.status === "loading" && <div className="skeleton tall" role="status" aria-label="Carregando a PR" />}
        {state.status === "error" && <p className="notice">Não deu para carregar a PR: {state.message}</p>}
        {tab === "files" && (
          <ReviewTab
            pr={pr}
            config={config}
            me={me}
            drafts={drafts}
            ai={aiState}
            agentName={ai?.agentName ?? agent?.name ?? "agente"}
            canRunAi={ai !== null}
            approved={approved}
            onApproved={(): void => setApprovedHere(true)}
            onDrafts={onDrafts}
            onAnalyze={onAnalyze}
            onChanged={onChanged}
          />
        )}
        {detail !== null && tab === "threads" && (
          <ThreadsTab
            pr={pr}
            config={config}
            detail={detail}
            me={me}
            agentBlocked={agentBlocked}
            draftReply={draftReply}
            resolveError={resolveError}
            focusId={focusId}
            onResolve={(t): void => void resolve(t)}
            onAgent={onOpenAgent}
            onChanged={onChanged}
          />
        )}
        {detail !== null && tab === "conversation" && (
          <>
            <DescriptionTab config={config} item={item} detail={detail} me={me} ai={ai} onChanged={onChanged} />
            <ConversationTab
              config={config}
              prId={pr.id}
              prAuthor={pr.author}
              me={me}
              detail={detail}
              focusId={focusId}
              onChanged={onChanged}
            />
          </>
        )}
        {detail !== null && tab === "checks" && (
          <ChecksTab
            config={config}
            repo={pr.repo}
            checks={detail.checks}
            agent={{ pr, blocked: agentBlocked, onAgent: onOpenAgent }}
            onChanged={onChanged}
          />
        )}
        {tab === "tree" && (
          <PrTree
            config={config}
            pr={pr}
            repoPulls={repoPulls}
            onOpenPr={(number): void => onOpenRef({ repo: pr.repo, number })}
          />
        )}

        {tab === "changes" && worktree !== null && (
          <ChangesTab pr={pr} config={config} worktree={worktree} waitingThreadIds={waitingIds} onChanged={onChanged} />
        )}
      </div>
    </article>
  );
}
