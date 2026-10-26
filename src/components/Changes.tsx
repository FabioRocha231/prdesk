import { GitCommitHorizontal, RefreshCw } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import type { Config } from "../lib/config";
import { replyToThread, resolveThread } from "../lib/github";
import { type Changes, commitAndPush, errorMessage, worktreeChanges } from "../lib/ipc";
import type { PullRequest } from "../lib/model";
import { DiffLines } from "./Threads";
import { useAction } from "./useAction";

interface FileDiff {
  path: string;
  body: string;
}

/** Splits `git diff` output into one block per file, keeping only the `@@` sections. */
export function splitDiff(diff: string): FileDiff[] {
  return diff
    .split(/^diff --git /m)
    .filter((block): boolean => block.trim() !== "")
    .map((block): FileDiff => {
      const path = /^\+\+\+ b\/(.+)$/m.exec(block)?.[1] ?? /^a\/(\S+)/.exec(block)?.[1] ?? "?";
      const start = block.indexOf("\n@@");
      return { path, body: start === -1 ? "" : block.slice(start + 1) };
    });
}

const STATUS_LABEL: Record<string, string> = { M: "modificado", A: "novo", D: "apagado", R: "renomeado", "?": "novo" };

export function ChangesTab({
  pr,
  config,
  worktree,
  waitingThreadIds,
  onChanged,
}: {
  pr: PullRequest;
  config: Config;
  worktree: string;
  waitingThreadIds: string[];
  onChanged: () => void;
}): ReactElement {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState(`Address review comments on #${pr.number}`);
  const [pushed, setPushed] = useState<string | null>(null);
  const action = useAction();

  const load = useCallback(async (): Promise<void> => {
    try {
      setChanges(await worktreeChanges(worktree, config.workspaceDir));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [worktree, config.workspaceDir]);

  useEffect((): void => {
    void load();
  }, [load]);

  const push = async (): Promise<void> => {
    await action.run("push", async (): Promise<void> => {
      setPushed(await commitAndPush(worktree, config.workspaceDir, message, pr.repoUrl));
      await load();
    });
  };

  const answerThreads = async (sha: string): Promise<void> => {
    const ok = await action.run("answer", async (): Promise<void> => {
      // Sequential on purpose: a handful of threads, and GitHub rate-limits bursts of mutations.
      for (const id of waitingThreadIds) {
        await replyToThread(config, id, `Corrigido em ${sha}.`);
        await resolveThread(config, id);
      }
    });
    if (ok) onChanged();
  };

  if (loadError !== null) return <p className="notice">Não deu para ler o worktree: {loadError}</p>;
  if (changes === null) return <div className="skeleton tall" role="status" aria-label="Lendo o worktree" />;

  const files = splitDiff(changes.diff);
  const dirty = changes.files.length > 0;
  const canPush = dirty || (changes.unpushed ?? 0) > 0;

  return (
    <div className="changes">
      <div className="changes-bar">
        <span className="changes-summary">
          <b>{changes.files.length}</b> {changes.files.length === 1 ? "arquivo alterado" : "arquivos alterados"}
          {changes.unpushed !== null && changes.unpushed > 0 && (
            <>
              {" "}
              · <b>{changes.unpushed}</b> commit(s) sem push
            </>
          )}
        </span>
        <span className="changes-path">{worktree}</span>
        <button type="button" className="text-button" onClick={(): void => void load()}>
          <RefreshCw size={14} strokeWidth={2} aria-hidden /> Recarregar
        </button>
      </div>

      {pushed !== null && (
        <div className="pushed">
          <span>
            Enviado: <b>{pushed}</b>
          </span>
          {waitingThreadIds.length > 0 && (
            <button
              type="button"
              className="button small"
              disabled={action.pending !== null}
              onClick={(): void => void answerThreads(pushed)}
            >
              {action.pending === "answer"
                ? "Respondendo…"
                : `Responder "Corrigido em ${pushed}" e resolver ${waitingThreadIds.length} thread(s)`}
            </button>
          )}
        </div>
      )}

      {canPush && (
        <div className="commit-box">
          <label className="visually-hidden" htmlFor="commit-message">
            Mensagem do commit
          </label>
          <input
            id="commit-message"
            className="input"
            value={message}
            maxLength={2000}
            disabled={!dirty}
            onChange={(e): void => setMessage(e.target.value)}
          />
          <button
            type="button"
            className="button primary"
            disabled={action.pending !== null || message.trim() === ""}
            onClick={(): void => void push()}
          >
            <GitCommitHorizontal size={16} strokeWidth={2} aria-hidden />
            {action.pending === "push" ? "Enviando…" : dirty ? "Commit & push" : "Push"}
          </button>
        </div>
      )}
      {action.error !== null && (
        <p className="action-error" role="alert">
          {action.error}
        </p>
      )}

      {!dirty && files.length === 0 && <p className="notice">Nenhuma mudança local no worktree.</p>}
      {changes.files.length > 0 && (
        <ul className="file-list">
          {changes.files.map((line): ReactElement => {
            const code = line.slice(0, 2).trim().charAt(0) || "?";
            return (
              <li key={line}>
                <span className={`file-status status-${code === "?" ? "A" : code}`}>{STATUS_LABEL[code] ?? code}</span>
                <span className="file-path">{line.slice(3)}</span>
              </li>
            );
          })}
        </ul>
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
      {changes.truncated && <p className="notice">Diff truncado em 400 KB.</p>}
    </div>
  );
}
