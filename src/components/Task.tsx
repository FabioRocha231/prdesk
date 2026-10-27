import { GitPullRequestCreate, Play, RefreshCw, Rocket, Wand2 } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DESCRIBE_PROMPT, readDescription } from "../lib/ai";
import type { Config } from "../lib/config";
import { createPull } from "../lib/github";
import { type Changes, commitAndPush, errorMessage, worktreeChanges } from "../lib/ipc";
import { slugify } from "../lib/mission";
import { splitDiff } from "./Changes";
import type { PrAi } from "./Detail";
import { DiffLines } from "./Threads";
import { useAction } from "./useAction";

const MAX_TASK = 4000;
const MAX_TITLE = 256;
const MAX_BODY = 65_000;

/** Work that has no PR yet: a branch and worktree where an agent builds it. */
export interface Task {
  id: string;
  repo: string;
  repoUrl: string;
  branch: string;
  text: string;
  /** Set once the worktree exists. */
  cwd: string | null;
  /** The issue this task resolves, in the same repo; the PR closes it. */
  issue?: number;
  /** Set when the task is one repo's part of a mission. */
  mission?: string;
}

/** What the dialog starts with when the task comes from an issue. */
export interface TaskSeed {
  repo: string;
  text: string;
  branch: string;
  issue: number;
}

/** "Add retry to the webhook sender" → "prdesk/add-retry-to-the-webhook-sender". */
export function branchFor(text: string): string {
  return `prdesk/${slugify(text) || "task"}`;
}

export function NewTaskDialog({
  repos,
  seed,
  onCreate,
  onClose,
}: {
  repos: string[];
  seed: TaskSeed | null;
  onCreate: (repo: string, branch: string, text: string, issue?: number) => void;
  onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [repo, setRepo] = useState(seed?.repo ?? repos[0] ?? "");
  const [text, setText] = useState(seed?.text ?? "");
  const [branch, setBranch] = useState<string | null>(seed?.branch ?? null);
  const finalBranch = branch ?? branchFor(text);
  const repoOk = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo);
  const valid = repoOk && text.trim() !== "" && finalBranch !== "";
  // Says what is missing instead of leaving a silent disabled button.
  const missing = !repoOk ? "Escolha o repositório (dono/repo)." : text.trim() === "" ? "Descreva a tarefa." : null;

  useEffect((): void => {
    dialog.current?.showModal();
    // showModal focuses the first field (the repo); the task text is what you type first.
    dialog.current?.querySelector("textarea")?.focus();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Esc closes the dialog natively
    <dialog
      ref={dialog}
      className="palette newtask"
      aria-label="Nova PR com agente"
      onClose={onClose}
      onClick={(e): void => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <form
        className="newtask-form"
        onSubmit={(e): void => {
          e.preventDefault();
          // The issue only links when the task stays in its repo.
          if (valid) onCreate(repo, finalBranch, text.trim(), seed?.repo === repo ? seed.issue : undefined);
        }}
      >
        <div className="palette-input">
          <GitPullRequestCreate size={18} strokeWidth={2} aria-hidden />
          <span className="feed-heading">Nova PR com agente</span>
          <kbd>Esc</kbd>
        </div>
        <div className="newtask-body">
          <label className="nt-field">
            <span>Repositório</span>
            <input
              className="input"
              list="known-repos"
              placeholder="dono/repo"
              value={repo}
              onChange={(e): void => setRepo(e.target.value.trim())}
            />
            <datalist id="known-repos">
              {repos.map(
                (r): ReactElement => (
                  <option key={r} value={r} />
                ),
              )}
            </datalist>
          </label>
          <label className="nt-field">
            <span>O que precisa ser feito?</span>
            <textarea
              className="input"
              rows={5}
              maxLength={MAX_TASK}
              placeholder="Ex.: adicionar retry com backoff no envio de webhooks e cobrir com teste"
              value={text}
              onChange={(e): void => setText(e.target.value)}
            />
          </label>
          <label className="nt-field">
            <span>Branch</span>
            <input
              className="input mono"
              placeholder="gerada a partir da tarefa"
              value={branch ?? (text.trim() === "" ? "" : finalBranch)}
              onChange={(e): void => setBranch(e.target.value)}
            />
          </label>
          <p className="hint">
            O app cria a branch a partir da principal num worktree e abre o agente com a tarefa. Quando terminar, a IA
            escreve título e descrição e você abre a PR daqui.
          </p>
          <div className="inline">
            <button type="submit" className="button primary" disabled={!valid}>
              <Rocket size={16} strokeWidth={2} aria-hidden /> Criar branch e abrir o agente
            </button>
            {missing !== null && <span className="hint">{missing}</span>}
          </div>
        </div>
      </form>
    </dialog>
  );
}

export function TaskView({
  task,
  config,
  ai,
  agentBusy,
  onOpenAgent,
  onCreated,
}: {
  task: Task;
  config: Config;
  ai: PrAi | null;
  agentBusy: boolean;
  onOpenAgent: () => void;
  onCreated: (number: number) => void;
}): ReactElement {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(true);
  const action = useAction();
  const cwd = task.cwd;

  const load = useCallback(async (): Promise<void> => {
    if (cwd === null) return;
    try {
      setChanges(await worktreeChanges(cwd, config.workspaceDir));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [cwd, config.workspaceDir]);

  useEffect((): void => {
    void load();
  }, [load]);

  const describe = async (): Promise<void> => {
    if (ai === null || changes === null) return;
    await action.run("describe", async (): Promise<void> => {
      const context = `# Task\n\n${task.text}\n\n# Diff\n\n\`\`\`diff\n${changes.diff}\n\`\`\``;
      const out = readDescription(await ai.run(DESCRIBE_PROMPT, context));
      setTitle(out.title);
      setBody(out.body);
    });
  };

  const open = async (): Promise<void> => {
    if (cwd === null) return;
    await action.run("open", async (): Promise<void> => {
      await commitAndPush(cwd, config.workspaceDir, title.trim(), task.repoUrl);
      const closes = task.issue === undefined || body.includes(`#${task.issue}`) ? "" : `\n\nCloses #${task.issue}`;
      const created = await createPull(config, task.repo, task.branch, title.trim(), `${body}${closes}`.trim(), draft);
      onCreated(created);
    });
  };

  const files = changes === null ? [] : splitDiff(changes.diff);
  const hasWork = changes !== null && (changes.files.length > 0 || (changes.unpushed ?? 1) > 0);

  return (
    <article className="detail task-view poster-waiting" aria-label="Tarefa">
      <header className="dhead">
        <div className="dhead-trail">
          <span className="dhead-repo">{task.repo}</span>
          <span className="dhead-branch">nova branch → {task.branch}</span>
        </div>
        <div className="dhead-main">
          <span className="dhead-number">
            <GitPullRequestCreate size={30} strokeWidth={2} aria-hidden />
          </span>
          <h1 className="dhead-title">{task.text}</h1>
        </div>
        <div className="dhead-bar">
          <span className="status-chip">
            <span className="status-dot" aria-hidden />
            {cwd === null ? "Preparando" : "Em andamento"}
          </span>
          <div className="actions">
            <button type="button" className="text-button" disabled={cwd === null} onClick={(): void => void load()}>
              <RefreshCw size={15} strokeWidth={2} aria-hidden /> Recarregar mudanças
            </button>
            <div className="agent-pick">
              <button type="button" onClick={onOpenAgent} disabled={agentBusy || cwd === null}>
                <Play size={15} strokeWidth={2.5} aria-hidden /> Abrir o agente
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="detail-body">
        {loadError !== null && <p className="notice">Não deu para ler o worktree: {loadError}</p>}
        {cwd === null && <p className="notice pulse">Criando a branch e o worktree…</p>}
        {changes !== null && !hasWork && (
          <p className="notice">Nenhuma mudança ainda. Acompanhe o agente no terminal abaixo e recarregue.</p>
        )}
        {changes !== null && hasWork && (
          <section className="open-pr">
            <div className="open-pr-head">
              <b>Abrir a PR</b>
              {ai !== null && (
                <button
                  type="button"
                  className="chip-button accent"
                  disabled={action.pending !== null}
                  onClick={(): void => void describe()}
                >
                  <Wand2 size={14} strokeWidth={2} aria-hidden />
                  {action.pending === "describe" ? "Escrevendo…" : `Escrever com ${ai.agentName}`}
                </button>
              )}
            </div>
            <input
              className="input"
              aria-label="Título da PR"
              placeholder="Título"
              maxLength={MAX_TITLE}
              value={title}
              onChange={(e): void => setTitle(e.target.value)}
            />
            <textarea
              className="input"
              aria-label="Descrição da PR"
              placeholder="Descrição (markdown)"
              rows={8}
              maxLength={MAX_BODY}
              value={body}
              onChange={(e): void => setBody(e.target.value)}
            />
            <div className="reply-actions">
              <label className="inline">
                <input type="checkbox" checked={draft} onChange={(e): void => setDraft(e.target.checked)} /> Abrir como
                rascunho
              </label>
              <button
                type="button"
                className="button primary"
                disabled={title.trim() === "" || action.pending !== null}
                onClick={(): void => void open()}
              >
                <GitPullRequestCreate size={16} strokeWidth={2} aria-hidden />
                {action.pending === "open" ? "Enviando…" : "Commit, push e abrir PR"}
              </button>
            </div>
            {action.error !== null && (
              <p className="action-error" role="alert">
                {action.error}
              </p>
            )}
          </section>
        )}
        {files.map(
          (f): ReactElement => (
            <article key={f.path} className="thread">
              <header className="thread-head">
                <span className="thread-path">{f.path}</span>
              </header>
              <DiffLines hunk={f.body} />
            </article>
          ),
        )}
      </div>
    </article>
  );
}
