import {
  ArrowUpRight,
  FolderOpen,
  GitPullRequestCreate,
  Play,
  RefreshCw,
  Rocket,
  Save,
  SearchCheck,
  Send,
  Sparkles,
  Workflow,
} from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { age } from "../lib/format";
import { contractChange, type Mission, type MissionCheck, type MissionPart, parsePlan, planHash } from "../lib/mission";

const MAX_REQUEST = 8000;
const MIN_REPOS = 2;

/** What one part's agent is doing, from its terminal session. */
export type PartStatus = "contract" | "preparing" | "working" | "waiting" | "exited" | "error" | "idle" | "pr";

const PART_LABEL: Record<PartStatus, string> = {
  contract: "pediu mudança de contrato",
  pr: "PR aberta",
  preparing: "preparando",
  working: "trabalhando",
  waiting: "aguardando você",
  exited: "terminou",
  error: "erro",
  idle: "não iniciado",
};

const PHASE_LABEL: Record<Mission["phase"], string> = {
  preparing: "Preparando worktrees",
  planning: "Agente planejando",
  ready: "Plano para revisar",
  running: "Agentes rodando",
  delivered: "PRs abertas",
  done: "Concluída",
};

// What needs the dev first, like the board: a contract request or a quiet agent beats one still working.
const ATTENTION: PartStatus[] = ["contract", "waiting", "error", "exited", "preparing", "working", "idle", "pr"];

type Tab = "plan" | "notes" | "check";

export function NewMissionDialog({
  repos,
  onCreate,
  onClose,
}: {
  repos: string[];
  onCreate: (request: string, repos: string[]) => void;
  onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [request, setRequest] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const shown = repos.filter((r): boolean => r.toLowerCase().includes(query.trim().toLowerCase()));
  const missing =
    request.trim() === ""
      ? "Descreva o que precisa acontecer."
      : picked.length < MIN_REPOS
        ? "Escolha pelo menos dois repos. Para um só, use Nova PR (P)."
        : null;

  useEffect((): void => {
    dialog.current?.showModal();
    dialog.current?.querySelector("textarea")?.focus();
  }, []);

  const toggle = (repo: string): void =>
    setPicked(picked.includes(repo) ? picked.filter((r): boolean => r !== repo) : [...picked, repo]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Esc closes the dialog natively
    <dialog
      ref={dialog}
      className="palette newtask"
      aria-label="Nova missão"
      onClose={onClose}
      onClick={(e): void => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <form
        className="newtask-form"
        onSubmit={(e): void => {
          e.preventDefault();
          if (missing === null) onCreate(request.trim(), picked);
        }}
      >
        <div className="palette-input">
          <Workflow size={18} strokeWidth={2} aria-hidden />
          <span className="feed-heading">Nova missão</span>
          <kbd>Esc</kbd>
        </div>
        <div className="newtask-body">
          <label className="nt-field">
            <span>O que precisa acontecer? A primeira linha vira o título.</span>
            <textarea
              className="input"
              rows={6}
              maxLength={MAX_REQUEST}
              placeholder="Ex.: mostrar o número do pedido no recibo. A API passa a devolver o número e o front exibe no recibo e no e-mail."
              value={request}
              onChange={(e): void => setRequest(e.target.value)}
            />
          </label>
          <fieldset className="nt-field mission-repos">
            <legend>
              Repos <b>{picked.length}</b>
            </legend>
            <input
              className="input"
              placeholder="Filtrar repos"
              aria-label="Filtrar repos"
              value={query}
              onChange={(e): void => setQuery(e.target.value)}
            />
            <div className="mission-repo-list">
              {shown.map(
                (r): ReactElement => (
                  <label key={r} className="inline">
                    <input type="checkbox" checked={picked.includes(r)} onChange={(): void => toggle(r)} /> {r}
                  </label>
                ),
              )}
            </div>
          </fieldset>
          <p className="hint">
            O app cria um worktree por repo, um agente lê o código de todos e escreve o plano com o contrato entre eles.
            Você revisa o plano antes de qualquer agente começar a mexer no código.
          </p>
          <div className="inline">
            <button type="submit" className="button primary" disabled={missing !== null}>
              <Sparkles size={16} strokeWidth={2} aria-hidden /> Preparar e planejar
            </button>
            {missing !== null && <span className="hint">{missing}</span>}
          </div>
        </div>
      </form>
    </dialog>
  );
}

/** The plan, one card per part sorted by who needs the dev, the selected part's notes and the integration check. */
function MissionDetail({
  mission,
  plan,
  notes,
  check,
  partStatus,
  canPlan,
  onSavePlan,
  onReloadPlan,
  onReveal,
  onReplan,
  onLaunch,
  onPropagate,
  onCheck,
  onDeliver,
  onOpenPart,
  onOpenPr,
}: {
  mission: Mission;
  /** plan.md as last read from disk. */
  plan: string;
  /** Each part's notes.md by task id. */
  notes: Record<string, string>;
  check: MissionCheck | undefined;
  partStatus: (m: Mission, p: MissionPart) => PartStatus;
  /** The selected agent has a headless command, so the plan and the check can run. */
  canPlan: boolean;
  onSavePlan: (text: string) => Promise<void>;
  onReloadPlan: () => void;
  onReveal: () => void;
  onReplan: () => void;
  onLaunch: () => void;
  onPropagate: () => void;
  onCheck: () => void;
  onDeliver: () => void;
  onOpenPart: (taskId: string) => void;
  onOpenPr: (repo: string, number: number) => void;
}): ReactElement {
  const [draft, setDraft] = useState(plan);
  const [saved, setSaved] = useState(plan);
  const [tab, setTab] = useState<Tab>("plan");
  const [picked, setPicked] = useState<string | null>(null);
  const savedRef = useRef(plan);
  // A newer file on disk replaces the editor only while the editor has no unsaved changes.
  useEffect((): void => {
    setDraft((d): string => (d === savedRef.current ? plan : d));
    savedRef.current = plan;
    setSaved(plan);
  }, [plan]);
  const markSaved = (text: string): void => {
    savedRef.current = text;
    setSaved(text);
  };
  const save = (): void => void onSavePlan(draft).then((): void => markSaved(draft));
  const dirty = draft !== saved;
  const parsed = parsePlan(draft);
  const busy = mission.phase === "preparing" || mission.phase === "planning";
  const running = mission.phase === "running";
  const launched = running || mission.phase === "delivered" || mission.phase === "done";
  const count = parsed.ok ? parsed.plan.parts.length : 0;
  const stale = running && mission.propagated !== undefined && mission.propagated !== planHash(saved);
  const parts = [...mission.parts].sort(
    (a, b): number => ATTENTION.indexOf(partStatus(mission, a)) - ATTENTION.indexOf(partStatus(mission, b)),
  );
  const waiting = parts.filter((p): boolean =>
    ["contract", "waiting", "error"].includes(partStatus(mission, p)),
  ).length;
  const selected = parts.find((p): boolean => p.taskId === picked) ?? parts[0];
  const selectedNotes = selected === undefined ? "" : (notes[selected.taskId] ?? "");

  return (
    <article className="mission" aria-label={mission.title}>
      <header className="mission-head">
        <div className="mission-title">
          <h1>{mission.title}</h1>
          <span className={`mission-phase phase-${mission.phase}`}>
            {busy && <span className="pulse">●</span>} {PHASE_LABEL[mission.phase]}
            {running && waiting > 0 && <b className="mission-waiting"> · {waiting} aguardando você</b>}
          </span>
        </div>
        <div className="mission-actions">
          <button type="button" className="text-button" onClick={onReveal}>
            <FolderOpen size={15} strokeWidth={2} aria-hidden /> Mostrar no Finder
          </button>
          <button type="button" className="text-button" onClick={onReloadPlan}>
            <RefreshCw size={15} strokeWidth={2} aria-hidden /> Recarregar do arquivo
          </button>
          {canPlan && !launched && (
            <button type="button" className="text-button" disabled={busy} onClick={onReplan}>
              <Sparkles size={15} strokeWidth={2} aria-hidden /> Refazer plano
            </button>
          )}
          {running && (
            <button
              type="button"
              className="text-button"
              disabled={dirty}
              title="Copia o plano para todos os worktrees e avisa cada agente para relê-lo"
              onClick={onPropagate}
            >
              <Send size={15} strokeWidth={2} aria-hidden /> Propagar plano
            </button>
          )}
          {running && canPlan && (
            <button
              type="button"
              className="text-button"
              disabled={check?.status === "running"}
              title="Um agente lê o diff de todos os repos e aponta o que não bate com o contrato"
              onClick={(): void => {
                setTab("check");
                onCheck();
              }}
            >
              <SearchCheck size={15} strokeWidth={2} aria-hidden /> Checar integração
            </button>
          )}
          {!launched && (
            <button
              type="button"
              className="step-button accent"
              disabled={busy || dirty || !parsed.ok}
              title={dirty ? "Salve o plano antes de iniciar" : undefined}
              onClick={onLaunch}
            >
              <Rocket size={15} strokeWidth={2} aria-hidden /> Iniciar {count} {count === 1 ? "agente" : "agentes"}
            </button>
          )}
          {running && (
            <button
              type="button"
              className="step-button accent"
              title="Commit, push e uma PR em rascunho por repo, na ordem de merge e já ligadas por Depende de"
              onClick={onDeliver}
            >
              <GitPullRequestCreate size={15} strokeWidth={2} aria-hidden /> Abrir PRs
            </button>
          )}
        </div>
      </header>

      {mission.error !== undefined && (
        <p className="action-error" role="alert">
          {mission.error}
        </p>
      )}
      {stale && (
        <p className="mission-stale" role="status">
          Plano alterado e ainda não propagado: os agentes estão trabalhando com a versão anterior.
        </p>
      )}

      <ul className="mission-parts">
        {parts.map((p): ReactElement => {
          const status = partStatus(mission, p);
          const request = status === "contract" ? contractChange(notes[p.taskId] ?? "") : null;
          const inPlan = !parsed.ok || parsed.plan.parts.some((pp): boolean => pp.repo === p.repo);
          const pr = p.pr;
          return (
            <li key={p.taskId} className={`mission-part status-${status}`} aria-current={p === selected}>
              <button
                type="button"
                className="mission-part-main"
                onClick={(): void => {
                  setPicked(p.taskId);
                  setTab("notes");
                }}
              >
                <span className="row-dot" aria-hidden />
                <span className="mission-part-repo">{p.repo}</span>
                <span className="mission-part-status">
                  {p.cwd === null && mission.phase === "preparing" ? "clonando" : PART_LABEL[status]}
                  {pr !== undefined && ` #${pr}`}
                  {!inPlan && " · fora do plano"}
                </span>
                {request !== null && <span className="mission-part-request">{request}</span>}
              </button>
              {pr !== undefined ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Abrir a PR ${p.repo}#${pr}`}
                  title="Abrir a PR"
                  onClick={(): void => onOpenPr(p.repo, pr)}
                >
                  <ArrowUpRight size={15} strokeWidth={2} aria-hidden />
                </button>
              ) : (
                status !== "idle" && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Abrir o agente de ${p.repo}`}
                    title="Abrir o terminal e o diff deste repo"
                    onClick={(): void => onOpenPart(p.taskId)}
                  >
                    <Play size={14} strokeWidth={2.5} aria-hidden />
                  </button>
                )
              )}
            </li>
          );
        })}
      </ul>

      <div className="tabs" role="tablist" aria-label="Seções da missão">
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === "plan"}
          onClick={(): void => setTab("plan")}
        >
          plan.md
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === "notes"}
          disabled={!launched}
          onClick={(): void => setTab("notes")}
        >
          Notas{selected === undefined ? "" : ` · ${selected.repo}`}
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === "check"}
          disabled={check === undefined}
          onClick={(): void => setTab("check")}
        >
          Integração
        </button>
      </div>

      {tab === "plan" && (
        <section className="mission-plan">
          <div className="mission-plan-bar">
            {!parsed.ok && <span className="action-error">{parsed.error}</span>}
            {parsed.ok && dirty && <span className="hint">alterações não salvas</span>}
            {running && !dirty && !stale && (
              <span className="hint">Ao salvar uma mudança, use “Propagar plano” para os agentes a receberem.</span>
            )}
            <button type="button" className="button small" disabled={!dirty} onClick={save}>
              <Save size={14} strokeWidth={2} aria-hidden /> Salvar
            </button>
          </div>
          {mission.phase === "planning" && plan.trim() === "" ? (
            <p className="notice pulse">
              O agente está lendo os repos e escrevendo o plano. Pode levar alguns minutos.
            </p>
          ) : (
            <textarea
              className="input mono mission-editor"
              aria-label="Plano da missão"
              spellCheck={false}
              value={draft}
              onChange={(e): void => setDraft(e.target.value)}
              onKeyDown={(e): void => {
                if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (dirty) save();
                }
              }}
            />
          )}
        </section>
      )}

      {tab === "notes" && (
        <section className="mission-notes">
          {selectedNotes.trim() === "" ? (
            <p className="notice">
              O agente de {selected?.repo} ainda não escreveu em .prdesk/notes.md. Pedidos de mudança de contrato
              aparecem aqui e no card.
            </p>
          ) : (
            <pre className="mission-notes-text">{selectedNotes}</pre>
          )}
        </section>
      )}

      {tab === "check" && check !== undefined && (
        <section className="mission-notes">
          {check.status === "running" && (
            <p className="notice pulse">Um agente está comparando os diffs de todos os repos com o contrato.</p>
          )}
          {check.status === "error" && (
            <p className="action-error" role="alert">
              Não deu para checar: {check.message}
            </p>
          )}
          {check.status === "done" && <pre className="mission-notes-text">{check.text}</pre>}
        </section>
      )}
    </article>
  );
}

export function MissionsView({
  missions,
  selectedId,
  plans,
  notes,
  checks,
  partStatus,
  canPlan,
  onSelect,
  onNew,
  onSavePlan,
  onReloadPlan,
  onReveal,
  onReplan,
  onLaunch,
  onPropagate,
  onCheck,
  onDeliver,
  onOpenPart,
  onOpenPr,
}: {
  missions: Mission[];
  selectedId: string | null;
  plans: Record<string, string>;
  notes: Record<string, string>;
  checks: Record<string, MissionCheck>;
  partStatus: (m: Mission, p: MissionPart) => PartStatus;
  canPlan: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSavePlan: (id: string, text: string) => Promise<void>;
  onReloadPlan: (id: string) => void;
  onReveal: (id: string) => void;
  onReplan: (id: string) => void;
  onLaunch: (id: string) => void;
  onPropagate: (id: string) => void;
  onCheck: (id: string) => void;
  onDeliver: (id: string) => void;
  onOpenPart: (taskId: string) => void;
  onOpenPr: (repo: string, number: number) => void;
}): ReactElement {
  const selected = missions.find((m): boolean => m.id === selectedId) ?? missions[0];
  const active = missions.filter((m): boolean => m.phase !== "done");
  const done = missions.filter((m): boolean => m.phase === "done");
  const item = (m: Mission): ReactElement => (
    <button
      key={m.id}
      type="button"
      className="missions-item"
      aria-current={m.id === selected?.id}
      onClick={(): void => onSelect(m.id)}
    >
      <span className="missions-item-title">{m.title}</span>
      <span className="missions-item-meta">
        {PHASE_LABEL[m.phase]} · {m.parts.length} repos · {age(m.createdAt)}
      </span>
    </button>
  );
  return (
    <div className="missions">
      <nav className="missions-list" aria-label="Missões">
        <button type="button" className="button primary small" onClick={onNew}>
          <Workflow size={14} strokeWidth={2} aria-hidden /> Nova missão
        </button>
        {active.map(item)}
        {done.length > 0 && <span className="missions-heading">Concluídas</span>}
        {done.map(item)}
      </nav>
      {selected === undefined ? (
        <div className="mission-empty">
          <p className="notice">
            Uma missão é uma mudança que atravessa vários repos: um agente planeja o contrato entre eles, você revisa e
            um agente por repo trabalha em paralelo.
          </p>
        </div>
      ) : (
        <MissionDetail
          key={selected.id}
          mission={selected}
          plan={plans[selected.id] ?? ""}
          notes={notes}
          check={checks[selected.id]}
          partStatus={partStatus}
          canPlan={canPlan}
          onSavePlan={async (text): Promise<void> => await onSavePlan(selected.id, text)}
          onReloadPlan={(): void => onReloadPlan(selected.id)}
          onReveal={(): void => onReveal(selected.id)}
          onReplan={(): void => onReplan(selected.id)}
          onLaunch={(): void => onLaunch(selected.id)}
          onPropagate={(): void => onPropagate(selected.id)}
          onCheck={(): void => onCheck(selected.id)}
          onDeliver={(): void => onDeliver(selected.id)}
          onOpenPart={onOpenPart}
          onOpenPr={onOpenPr}
        />
      )}
    </div>
  );
}
