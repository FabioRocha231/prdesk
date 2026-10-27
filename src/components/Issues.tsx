import { ArrowUpRight, CircleDot, Play } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef } from "react";

import { age } from "../lib/format";
import type { Issue } from "../lib/github";

/** Open issues assigned to me; each one can start an agent task whose PR closes it. */
export function IssuesDialog({
  issues,
  error,
  onStart,
  onOpenUrl,
  onClose,
}: {
  issues: Issue[] | null;
  error: string | null;
  onStart: (issue: Issue) => void;
  onOpenUrl: (url: string) => void;
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
                aria-label={`Abrir ${i.repo}#${i.number} no GitHub`}
                title="Abrir no GitHub"
                onClick={(): void => onOpenUrl(i.url)}
              >
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden />
              </button>
            </li>
          ),
        )}
      </ul>
    </dialog>
  );
}
