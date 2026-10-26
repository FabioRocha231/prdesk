import { Check, ChevronDown, ChevronRight, Lightbulb, MessageSquarePlus, Pencil, Sparkles, Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import type { Config } from "../lib/config";
import { numberHunk } from "../lib/diff";
import { fetchFiles, type ReviewEvent, setViewed, submitReview } from "../lib/github";
import { errorMessage } from "../lib/ipc";
import type { AiReview, DraftComment, PrFile, PullRequest } from "../lib/model";
import { CodeText, useDiffTokens } from "./Code";
import { useAction } from "./useAction";

const MAX_COMMENT = 65_000;

export type AiState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; review: AiReview }
  | { status: "error"; message: string };

const STATUS_MARK: Record<string, string> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C" };

function fileId(path: string): string {
  return `file-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function scrollToFile(path: string): void {
  document.getElementById(fileId(path))?.scrollIntoView({ behavior: "smooth", block: "start" });
}

interface Target {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  text: string;
  /** Set when editing an existing draft. */
  key?: string;
}

function Composer({
  target,
  initial,
  onSave,
  onCancel,
}: {
  target: Target;
  initial: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}): ReactElement {
  const [body, setBody] = useState(initial);
  const save = (): void => {
    if (body.trim() !== "") onSave(body.trim());
  };
  return (
    <div className="composer">
      <textarea
        className="input"
        rows={3}
        maxLength={MAX_COMMENT}
        // biome-ignore lint/a11y/noAutofocus: opens on an explicit click on a line
        autoFocus
        placeholder="Comentário… (markdown, ⌘↵ adiciona ao review)"
        value={body}
        onChange={(e): void => setBody(e.target.value)}
        onKeyDown={(e): void => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="reply-actions">
        <button type="button" className="button primary small" disabled={body.trim() === ""} onClick={save}>
          {target.key === undefined ? "Adicionar ao review" : "Salvar"}
        </button>
        {target.side === "RIGHT" && (
          <button
            type="button"
            className="button small"
            title="Propõe a troca da linha; o autor aplica com um clique"
            onClick={(): void => setBody(`${body}${body === "" ? "" : "\n"}\`\`\`suggestion\n${target.text}\n\`\`\`\n`)}
          >
            <Lightbulb size={14} strokeWidth={2} aria-hidden /> Sugestão
          </button>
        )}
        <button type="button" className="text-button" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function DraftView({
  draft,
  onEdit,
  onRemove,
}: {
  draft: DraftComment;
  onEdit: () => void;
  onRemove: () => void;
}): ReactElement {
  return (
    <div className={draft.fromAi ? "draft is-ai" : "draft"}>
      <div className="draft-head">
        <span className="draft-tag">{draft.fromAi ? "Sugestão da IA · rascunho" : "Rascunho"}</span>
        <button type="button" className="text-button" onClick={onEdit}>
          <Pencil size={13} strokeWidth={2} aria-hidden /> Editar
        </button>
        <button type="button" className="text-button" onClick={onRemove}>
          <Trash2 size={13} strokeWidth={2} aria-hidden /> Remover
        </button>
      </div>
      <p className="draft-body">{draft.body}</p>
    </div>
  );
}

function FileDiff({
  file,
  drafts,
  target,
  onTarget,
  onSave,
  onRemove,
}: {
  file: PrFile;
  drafts: DraftComment[];
  target: Target | null;
  onTarget: (t: Target | null) => void;
  onSave: (t: Target, body: string) => void;
  onRemove: (key: string) => void;
}): ReactElement {
  if (file.patch === null) {
    return <p className="notice">Sem diff para mostrar: arquivo binário ou grande demais para a API do GitHub.</p>;
  }
  return (
    <FileLines
      file={file}
      patch={file.patch}
      drafts={drafts}
      target={target}
      onTarget={onTarget}
      onSave={onSave}
      onRemove={onRemove}
    />
  );
}

function FileLines({
  file,
  patch,
  drafts,
  target,
  onTarget,
  onSave,
  onRemove,
}: {
  file: PrFile;
  patch: string;
  drafts: DraftComment[];
  target: Target | null;
  onTarget: (t: Target | null) => void;
  onSave: (t: Target, body: string) => void;
  onRemove: (key: string) => void;
}): ReactElement {
  const lines = numberHunk(patch);
  const tokens = useDiffTokens(lines, file.path);
  return (
    <div className="rdiff">
      {lines.map((l, i): ReactElement => {
        if (l.kind === "meta") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static and may repeat
            <div key={i} className="rline rline-meta">
              <code>{l.text}</code>
            </div>
          );
        }
        const side = l.kind === "del" ? "LEFT" : "RIGHT";
        const line = (side === "LEFT" ? l.oldNo : l.newNo) ?? 0;
        const here = drafts.filter((d): boolean => d.side === side && d.line === line);
        const open = target !== null && target.side === side && target.line === line;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static and may repeat
          <div key={i} className="rline-group">
            <div className={`rline rline-${l.kind}`}>
              <button
                type="button"
                className="rline-plus"
                aria-label={`Comentar na linha ${line}`}
                onClick={(): void => onTarget({ path: file.path, line, side, text: l.text })}
              >
                <MessageSquarePlus size={13} strokeWidth={2} aria-hidden />
              </button>
              <span className="rline-no">{l.oldNo ?? ""}</span>
              <span className="rline-no">{l.newNo ?? ""}</span>
              <span className="rline-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
              <CodeText text={l.text} tokens={tokens?.[i]} />
            </div>
            {here.map(
              (d): ReactElement =>
                open && target.key === d.key ? (
                  <Composer
                    key={d.key}
                    target={target}
                    initial={d.body}
                    onSave={(body): void => onSave(target, body)}
                    onCancel={(): void => onTarget(null)}
                  />
                ) : (
                  <DraftView
                    key={d.key}
                    draft={d}
                    onEdit={(): void => onTarget({ path: file.path, line, side, text: l.text, key: d.key })}
                    onRemove={(): void => onRemove(d.key)}
                  />
                ),
            )}
            {open && target.key === undefined && (
              <Composer
                target={target}
                initial=""
                onSave={(body): void => onSave(target, body)}
                onCancel={(): void => onTarget(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function AiPanel({
  ai,
  agentName,
  canRun,
  aiDrafts,
  onAnalyze,
}: {
  ai: AiState;
  agentName: string;
  canRun: boolean;
  aiDrafts: number;
  onAnalyze: () => void;
}): ReactElement {
  return (
    <section className="ai-panel" aria-label="Análise da IA">
      <header className="ai-head">
        <Sparkles size={16} strokeWidth={2} aria-hidden />
        <b>Análise da IA</b>
        {ai.status === "idle" && (
          <span className="ai-hint">
            Resumo, riscos e comentários sugeridos. Nada vai para o GitHub sem você enviar.
          </span>
        )}
        <button
          type="button"
          className="chip-button accent"
          disabled={!canRun || ai.status === "running"}
          title={canRun ? undefined : "Configure o comando sem terminal do agente em Ajustes"}
          onClick={onAnalyze}
        >
          {ai.status === "running"
            ? "Analisando…"
            : ai.status === "done"
              ? "Analisar de novo"
              : `Analisar com ${agentName}`}
        </button>
      </header>
      {ai.status === "running" && (
        <p className="ai-note pulse">Lendo o diff e o código. Costuma levar de 1 a 5 minutos.</p>
      )}
      {ai.status === "error" && (
        <p className="action-error" role="alert">
          {ai.message}
        </p>
      )}
      {ai.status === "done" && (
        <div className="ai-result">
          <p className="ai-summary">{ai.review.summary}</p>
          {ai.review.risks.length > 0 && (
            <div>
              <span className="ai-label">Riscos</span>
              <ul className="ai-risks">
                {ai.review.risks.map(
                  (r): ReactElement => (
                    <li key={r}>{r}</li>
                  ),
                )}
              </ul>
            </div>
          )}
          {ai.review.lookFirst.length > 0 && (
            <div>
              <span className="ai-label">Olhe primeiro</span>
              <ul className="ai-look">
                {ai.review.lookFirst.map(
                  (l): ReactElement => (
                    <li key={l.path}>
                      <button type="button" className="ai-file" onClick={(): void => scrollToFile(l.path)}>
                        {l.path}
                      </button>
                      <span>{l.why}</span>
                    </li>
                  ),
                )}
              </ul>
            </div>
          )}
          <p className="ai-note">
            {aiDrafts === 0
              ? "Nenhum comentário sugerido em linha."
              : `${aiDrafts} comentário(s) sugerido(s) nas linhas, marcados como rascunho da IA: edite, remova ou envie com o review.`}
          </p>
        </div>
      )}
    </section>
  );
}

export function ReviewTab({
  pr,
  config,
  me,
  drafts,
  ai,
  agentName,
  canRunAi,
  onDrafts,
  onAnalyze,
  onChanged,
}: {
  pr: PullRequest;
  config: Config;
  me: string;
  drafts: DraftComment[];
  ai: AiState;
  agentName: string;
  canRunAi: boolean;
  onDrafts: (next: DraftComment[]) => void;
  onAnalyze: (files: PrFile[]) => void;
  onChanged: () => void;
}): ReactElement {
  const [files, setFiles] = useState<PrFile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<Target | null>(null);
  const [body, setBody] = useState("");
  const action = useAction();
  const mine = pr.author === me;

  // Keyed on identity, not the object: the board refresh hands a new `pr` every poll.
  const { id, repo, number } = pr;
  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const loaded = await fetchFiles(config, { id, repo, number });
        setFiles(loaded);
        // Already-viewed files start folded, like on GitHub.
        setCollapsed(new Set(loaded.filter((f): boolean => f.viewed).map((f): string => f.path)));
      } catch (e) {
        setLoadError(errorMessage(e));
      }
    })();
  }, [config, id, repo, number]);

  const byFile = useMemo((): Map<string, DraftComment[]> => {
    const map = new Map<string, DraftComment[]>();
    for (const d of drafts) map.set(d.path, [...(map.get(d.path) ?? []), d]);
    return map;
  }, [drafts]);

  const toggleViewed = async (file: PrFile): Promise<void> => {
    const viewed = !file.viewed;
    const apply = (value: boolean): void =>
      setFiles((all): PrFile[] | null =>
        all === null ? all : all.map((f): PrFile => (f.path === file.path ? { ...f, viewed: value } : f)),
      );
    apply(viewed);
    setCollapsed((c): Set<string> => {
      const next = new Set(c);
      if (viewed) next.add(file.path);
      else next.delete(file.path);
      return next;
    });
    const ok = await action.run(`viewed-${file.path}`, async (): Promise<void> => {
      await setViewed(config, pr.id, file.path, viewed);
    });
    if (!ok) apply(!viewed);
  };

  const saveDraft = (t: Target, text: string): void => {
    if (t.key !== undefined) {
      onDrafts(drafts.map((d): DraftComment => (d.key === t.key ? { ...d, body: text } : d)));
    } else {
      onDrafts([
        ...drafts,
        { key: `me-${Date.now()}`, path: t.path, line: t.line, side: t.side, body: text, fromAi: false },
      ]);
    }
    setTarget(null);
  };

  const submit = async (event: ReviewEvent): Promise<void> => {
    const comments = drafts.map((d) => ({ path: d.path, line: d.line, side: d.side, body: d.body }));
    const ok = await action.run(`submit-${event}`, async (): Promise<void> => {
      await submitReview(config, pr, event, body.trim(), comments);
    });
    if (ok) {
      onDrafts([]);
      setBody("");
      onChanged();
    }
  };

  if (loadError !== null) return <p className="notice">Não deu para carregar os arquivos: {loadError}</p>;
  if (files === null) return <div className="skeleton tall" role="status" aria-label="Carregando os arquivos" />;

  const viewedCount = files.filter((f): boolean => f.viewed).length;
  const aiDrafts = drafts.filter((d): boolean => d.fromAi).length;
  const hasContent = body.trim() !== "" || drafts.length > 0;

  return (
    <div className="review">
      <AiPanel
        ai={ai}
        agentName={agentName}
        canRun={canRunAi}
        aiDrafts={aiDrafts}
        onAnalyze={(): void => onAnalyze(files)}
      />

      <div className="review-layout">
        <nav className="ftree" aria-label="Arquivos alterados">
          <div className="ftree-head">
            <span>Arquivos</span>
            <b>
              {viewedCount}/{files.length} vistos
            </b>
          </div>
          <div className="ftree-bar" aria-hidden>
            <span style={{ width: `${files.length === 0 ? 0 : (viewedCount / files.length) * 100}%` }} />
          </div>
          {files.map((f): ReactElement => {
            const name = f.path.split("/").at(-1) ?? f.path;
            const dir = f.path.slice(0, f.path.length - name.length);
            const pending = byFile.get(f.path)?.length ?? 0;
            return (
              <button
                key={f.path}
                type="button"
                className={f.viewed ? "ftree-item is-viewed" : "ftree-item"}
                title={f.path}
                onClick={(): void => {
                  setCollapsed((c): Set<string> => {
                    const next = new Set(c);
                    next.delete(f.path);
                    return next;
                  });
                  window.requestAnimationFrame((): void => scrollToFile(f.path));
                }}
              >
                <span className={`fstatus fstatus-${f.status}`}>{STATUS_MARK[f.status] ?? "M"}</span>
                <span className="ftree-name">
                  <b>{name}</b>
                  {dir !== "" && <span>{dir}</span>}
                </span>
                {pending > 0 && <span className="ftree-pending">{pending}</span>}
                {f.viewed && <Check size={13} strokeWidth={2.5} aria-label="visto" />}
              </button>
            );
          })}
        </nav>

        <div className="rfiles">
          {files.map((f): ReactElement => {
            const folded = collapsed.has(f.path);
            return (
              <section key={f.path} id={fileId(f.path)} className={f.viewed ? "rfile is-viewed" : "rfile"}>
                <header className="rfile-head">
                  <button
                    type="button"
                    className="rfile-fold"
                    aria-expanded={!folded}
                    onClick={(): void =>
                      setCollapsed((c): Set<string> => {
                        const next = new Set(c);
                        if (folded) next.delete(f.path);
                        else next.add(f.path);
                        return next;
                      })
                    }
                  >
                    {folded ? (
                      <ChevronRight size={15} strokeWidth={2} aria-hidden />
                    ) : (
                      <ChevronDown size={15} strokeWidth={2} aria-hidden />
                    )}
                    <span className="rfile-path">
                      {f.previousPath !== null && <span className="rfile-old">{f.previousPath} → </span>}
                      {f.path}
                    </span>
                  </button>
                  <span className="rfile-stats">
                    <b className="tone-add">+{f.additions}</b>
                    <b className="tone-del">−{f.deletions}</b>
                  </span>
                  <label className="rfile-viewed">
                    <input type="checkbox" checked={f.viewed} onChange={(): void => void toggleViewed(f)} />
                    Visto
                  </label>
                </header>
                {!folded && (
                  <FileDiff
                    file={f}
                    drafts={byFile.get(f.path) ?? []}
                    target={target?.path === f.path ? target : null}
                    onTarget={setTarget}
                    onSave={saveDraft}
                    onRemove={(key): void => onDrafts(drafts.filter((d): boolean => d.key !== key))}
                  />
                )}
              </section>
            );
          })}
        </div>
      </div>

      <footer className="submit-bar">
        <textarea
          className="input"
          rows={1}
          maxLength={MAX_COMMENT}
          placeholder="Comentário geral do review (opcional)"
          value={body}
          onChange={(e): void => setBody(e.target.value)}
        />
        <div className="submit-actions">
          <span className="submit-count">
            {drafts.length === 0 ? "Nenhum comentário pendente" : `${drafts.length} comentário(s) no rascunho`}
          </span>
          <button
            type="button"
            className="button small"
            disabled={!hasContent || action.pending !== null}
            onClick={(): void => void submit("COMMENT")}
          >
            {action.pending === "submit-COMMENT" ? "Enviando…" : "Comentar"}
          </button>
          {!mine && (
            <>
              <button
                type="button"
                className="button small danger"
                disabled={!hasContent || action.pending !== null}
                title={hasContent ? undefined : "Explique o que precisa mudar"}
                onClick={(): void => void submit("REQUEST_CHANGES")}
              >
                {action.pending === "submit-REQUEST_CHANGES" ? "Enviando…" : "Pedir mudanças"}
              </button>
              <button
                type="button"
                className="button primary small"
                disabled={action.pending !== null}
                onClick={(): void => void submit("APPROVE")}
              >
                {action.pending === "submit-APPROVE" ? "Enviando…" : "Aprovar"}
              </button>
            </>
          )}
        </div>
        {action.error !== null && (
          <p className="action-error" role="alert">
            {action.error}
          </p>
        )}
      </footer>
    </div>
  );
}
