import { GitBranchPlus, GitPullRequestCreate, OctagonAlert } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { Config } from "../lib/config";
import { age } from "../lib/format";
import { type BrokenBase, createPull, fetchBranchChecks, type Radar, type StrayBranch } from "../lib/github";
import type { Check } from "../lib/model";
import { ChecksTab } from "./Checks";
import { useAction } from "./useAction";

const MAX_TITLE = 256;
const MAX_BODY = 65_000;

/** What happened outside the PRs: branches I pushed without opening one, and default branches gone red. */
export function RadarStrip({
  radar,
  onOpenBranch,
  onOpenBase,
}: {
  radar: Radar;
  onOpenBranch: (branch: StrayBranch) => void;
  onOpenBase: (base: BrokenBase) => void;
}): ReactElement {
  return (
    <nav className="tasks-strip" aria-label="Fora das PRs">
      {radar.broken.length > 0 && <span className="tasks-label">Base falhando</span>}
      {radar.broken.map(
        (b): ReactElement => (
          <button
            key={b.repo}
            type="button"
            className="task-chip is-bad"
            title="O último commit da branch principal falha no CI: as PRs que partem dela podem falhar por isso"
            onClick={(): void => onOpenBase(b)}
          >
            <OctagonAlert size={14} strokeWidth={2} aria-hidden />
            <span className="task-repo">{b.repo}</span>
            <span className="task-text">{b.branch}</span>
          </button>
        ),
      )}
      {radar.branches.length > 0 && <span className="tasks-label">Sem PR</span>}
      {radar.branches.map(
        (b): ReactElement => (
          <button
            key={`${b.repo}:${b.branch}`}
            type="button"
            className="task-chip"
            title={`${b.subject} · abrir PR desta branch`}
            onClick={(): void => onOpenBranch(b)}
          >
            <GitBranchPlus size={14} strokeWidth={2} aria-hidden />
            <span className="task-repo">{b.repo}</span>
            <span className="task-text">{b.branch}</span>
            <span className="task-live">{age(b.pushedAt)}</span>
          </button>
        ),
      )}
    </nav>
  );
}

/** Opens a PR from a branch that is already pushed; the description can be improved with AI inside the PR. */
export function BranchPrDialog({
  config,
  branch,
  onCreated,
  onClose,
}: {
  config: Config;
  branch: StrayBranch;
  onCreated: (number: number) => void;
  onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(branch.subject);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(true);
  const action = useAction();

  useEffect((): void => {
    dialog.current?.showModal();
  }, []);

  const open = async (): Promise<void> => {
    let number = 0;
    const ok = await action.run("open", async (): Promise<void> => {
      number = await createPull(config, branch.repo, branch.branch, title.trim(), body, draft);
    });
    if (ok) onCreated(number);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Esc closes the dialog natively
    <dialog
      ref={dialog}
      className="palette newtask"
      aria-label="Abrir PR da branch"
      onClose={onClose}
      onClick={(e): void => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <form
        className="newtask-form"
        onSubmit={(e): void => {
          e.preventDefault();
          if (title.trim() !== "") void open();
        }}
      >
        <div className="palette-input">
          <GitPullRequestCreate size={18} strokeWidth={2} aria-hidden />
          <span className="feed-heading">
            Abrir PR · {branch.repo} · {branch.branch}
          </span>
          <kbd>Esc</kbd>
        </div>
        <div className="newtask-body">
          <label className="nt-field">
            <span>Título</span>
            <input
              className="input"
              maxLength={MAX_TITLE}
              value={title}
              onChange={(e): void => setTitle(e.target.value)}
            />
          </label>
          <label className="nt-field">
            <span>Descrição</span>
            <textarea
              className="input"
              rows={6}
              maxLength={MAX_BODY}
              placeholder="Markdown. Dentro da PR, “Editar descrição” reescreve com IA a partir do diff."
              value={body}
              onChange={(e): void => setBody(e.target.value)}
            />
          </label>
          <div className="inline">
            <label className="inline">
              <input type="checkbox" checked={draft} onChange={(e): void => setDraft(e.target.checked)} /> Abrir como
              rascunho
            </label>
            <button type="submit" className="button primary" disabled={title.trim() === "" || action.pending !== null}>
              <GitPullRequestCreate size={16} strokeWidth={2} aria-hidden />
              {action.pending === "open" ? "Abrindo…" : "Abrir PR"}
            </button>
          </div>
          {action.error !== null && (
            <p className="action-error" role="alert">
              {action.error}
            </p>
          )}
        </div>
      </form>
    </dialog>
  );
}

/** Why a default branch is red: its checks and their logs, without leaving the app. */
export function BaseChecksDialog({
  config,
  base,
  onClose,
}: {
  config: Config;
  base: BrokenBase;
  onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);

  useEffect((): void => {
    dialog.current?.showModal();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `loads` is the refetch trigger after a re-run
  useEffect((): (() => void) => {
    let live = true;
    fetchBranchChecks(config, base.repo, base.branch).then(
      (c): void => {
        if (live) setChecks(c);
      },
      (e: unknown): void => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return (): void => {
      live = false;
    };
  }, [config, base, loads]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Esc closes the dialog natively
    <dialog
      ref={dialog}
      className="palette newtask"
      aria-label="CI da branch principal"
      onClose={onClose}
      onClick={(e): void => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="palette-input">
        <OctagonAlert size={18} strokeWidth={2} aria-hidden />
        <span className="feed-heading">
          CI falhando · {base.repo} · {base.branch}
        </span>
        <kbd>Esc</kbd>
      </div>
      <div className="newtask-body">
        {error !== null ? (
          <p className="action-error" role="alert">
            {error}
          </p>
        ) : checks === null ? (
          <p className="notice">Carregando os checks…</p>
        ) : (
          <ChecksTab
            config={config}
            repo={base.repo}
            checks={checks}
            agent={null}
            onChanged={(): void => setLoads((n): number => n + 1)}
          />
        )}
      </div>
    </dialog>
  );
}
