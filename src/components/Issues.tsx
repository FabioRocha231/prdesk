import { ArrowUpRight, BookOpen, CircleDot, Play } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { Config } from "../lib/config";
import type { PrRef } from "../lib/deps";
import { age } from "../lib/format";
import { fetchIssue, type Issue, type IssueDetail } from "../lib/github";
import { errorMessage } from "../lib/ipc";
import { ConversationTab } from "./Detail";
import { Html } from "./Html";

/** Open issues assigned to me; each one can start an agent task whose PR closes it. */
export function IssuesDialog({
  issues,
  error,
  onStart,
  onRead,
  onClose,
}: {
  issues: Issue[] | null;
  error: string | null;
  onStart: (issue: Issue) => void;
  onRead: (issue: Issue) => void;
  onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect((): void => {
    dialog.current?.showModal();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Esc closes the dialog natively
    <dialog
      ref={dialog}
      className="palette feed"
      aria-label="Issues atribuídas a você"
      onClose={onClose}
      onClick={(e): void => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="palette-input">
        <CircleDot size={18} strokeWidth={2} aria-hidden />
        <span className="feed-heading">Issues atribuídas a você</span>
        <kbd>Esc</kbd>
      </div>
      <ul className="palette-list">
        {error !== null && (
          <li className="palette-empty" role="alert">
            Não deu para carregar as issues: {error}
          </li>
        )}
        {issues === null && error === null && (
          <li className="palette-empty">
            <div className="skeleton" role="status" aria-label="Carregando" />
          </li>
        )}
        {issues?.length === 0 && <li className="palette-empty">Nenhuma issue aberta atribuída a você.</li>}
        {issues?.map(
          (i): ReactElement => (
            <li key={i.id} className="issue-row">
              <button
                type="button"
                className="feed-item"
                title="Cria a branch, abre o agente com a issue e a PR fecha a issue"
                onClick={(): void => onStart(i)}
              >
                <span className="row-dot" aria-hidden />
                <span className="feed-body">
                  <span className="feed-title">{i.title}</span>
                  <span className="feed-where">
                    {i.repo}#{i.number}
                    {i.labels.length > 0 && ` · ${i.labels.join(", ")}`}
                  </span>
                </span>
                <span className="issue-start">
                  <Play size={13} strokeWidth={2.5} aria-hidden /> Começar
                </span>
                <span className="palette-age">{age(i.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Ler ${i.repo}#${i.number}`}
                title="Ler a issue"
                onClick={(): void => onRead(i)}
              >
                <BookOpen size={16} strokeWidth={2} aria-hidden />
              </button>
            </li>
          ),
        )}
      </ul>
    </dialog>
  );
}

/** Reads an issue and its conversation, comments on it, or starts working on it, without the browser. */
export function IssueDialog({
  config,
  me,
  issue: ref,
  onStart,
  onNotIssue,
  onOpenUrl,
  onClose,
}: {
  config: Config;
  me: string;
  issue: PrRef;
  onStart: (issue: Issue) => void;
  /** The number is a PR (an /issues/ link to it): open it as one. */
  onNotIssue: () => void;
  onOpenUrl: (url: string) => void;
  onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);

  useEffect((): void => {
    dialog.current?.showModal();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `loads` refetches after a comment
  useEffect((): (() => void) => {
    let live = true;
    fetchIssue(config, ref.repo, ref.number).then(
      (i): void => {
        if (!live) return;
        if (i === null) onNotIssue();
        else setIssue(i);
      },
      (e: unknown): void => {
        if (live) setError(errorMessage(e));
      },
    );
    return (): void => {
      live = false;
    };
  }, [config, ref.repo, ref.number, loads]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Esc closes the dialog natively
    <dialog
      ref={dialog}
      className="palette newtask issue-view"
      aria-label={`Issue ${ref.repo}#${ref.number}`}
      onClose={onClose}
      onClick={(e): void => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="palette-input">
        <CircleDot size={18} strokeWidth={2} aria-hidden />
        <span className="feed-heading">
          {ref.repo}#{ref.number}
          {issue !== null && ` · ${issue.title}`}
          {issue?.closed === true && " · fechada"}
        </span>
        <kbd>Esc</kbd>
      </div>
      <div className="newtask-body">
        {error !== null && (
          <p className="action-error" role="alert">
            Não deu para carregar a issue: {error}
          </p>
        )}
        {issue === null && error === null && <div className="skeleton" role="status" aria-label="Carregando" />}
        {issue !== null && (
          <>
            <div className="inline">
              {!issue.closed && (
                <button type="button" className="button primary small" onClick={(): void => onStart(issue)}>
                  <Play size={13} strokeWidth={2.5} aria-hidden /> Começar
                </button>
              )}
              <button type="button" className="button small" onClick={(): void => onOpenUrl(issue.url)}>
                <ArrowUpRight size={14} strokeWidth={2} aria-hidden /> Abrir no GitHub
              </button>
            </div>
            {issue.bodyHTML.trim() === "" ? (
              <p className="notice">Sem descrição.</p>
            ) : (
              <div className="comment">
                <div className="comment-head">
                  <b>{issue.author}</b>
                  <span className="comment-age">{age(issue.createdAt)}</span>
                </div>
                <div className="comment-body">
                  <Html html={issue.bodyHTML} />
                </div>
              </div>
            )}
            <ConversationTab
              config={config}
              subjectId={issue.id}
              prAuthor={null}
              me={me}
              timeline={issue.timeline}
              focusId={null}
              placeholder="Comentar na issue… (⌘↵ envia)"
              onChanged={(): void => setLoads((n): number => n + 1)}
            />
          </>
        )}
      </div>
    </dialog>
  );
}
