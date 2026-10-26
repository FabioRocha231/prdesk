import { ArrowRight } from "lucide-react";
import type { ReactElement } from "react";

import { shortRef } from "../lib/deps";
import { COLUMN_LABEL, type TriagedPull } from "../lib/model";

function ChainCard({ item, onSelect }: { item: TriagedPull; onSelect: (id: string) => void }): ReactElement {
  const { pr, triage } = item;
  return (
    <button type="button" className={`chain-card row-${triage.column}`} onClick={(): void => onSelect(pr.id)}>
      <span className="chain-card-top">
        <span className="chain-card-ref">{shortRef(pr)}</span>
        <span className="chain-card-status">
          <span className="status-dot" aria-hidden />
          {COLUMN_LABEL[triage.column]}
        </span>
      </span>
      <span className="chain-card-title">{pr.title}</span>
      <span className="chain-card-meta">
        {pr.branch === "conflicts" && <span className="flag flag-warn">Conflitos</span>}
        {pr.branch === "behind" && <span className="flag flag-dim">Desatualizada</span>}
        {pr.isDraft && <span className="flag flag-dim">Rascunho</span>}
        {pr.reviewDecision === "APPROVED" && <span className="flag flag-good">Aprovada</span>}
        {!pr.isDraft && pr.reviewDecision !== "APPROVED" && pr.branch === "ok" && (
          <span className="chain-card-reason">{triage.reason}</span>
        )}
      </span>
    </button>
  );
}

/** PRs linked by "Depende de", one row per chain, left to right in the order they should merge. */
export function Chains({
  chains,
  onSelect,
}: {
  chains: TriagedPull[][][];
  onSelect: (id: string) => void;
}): ReactElement {
  return (
    <section className="chains" aria-label="PRs encadeadas">
      <p className="chains-intro">
        PRs ligadas por "Depende de", em etapas de merge: a etapa da esquerda entra primeiro; PRs empilhadas na mesma
        etapa podem entrar em qualquer ordem.
      </p>
      {chains.length === 0 && <p className="chains-intro">Nenhuma PR do quadro depende de outra.</p>}
      {chains.map(
        (chain): ReactElement => (
          <ol
            key={chain
              .flat()
              .map((t): string => t.pr.id)
              .join("|")}
            className="chain-row"
          >
            {chain.map(
              (step, i): ReactElement => (
                <li key={step.map((t): string => t.pr.id).join("|")} className="chain-step">
                  {i > 0 && <ArrowRight className="chain-arrow" size={16} strokeWidth={2} aria-label="depois" />}
                  <div className="chain-stack">
                    {step.map(
                      (t): ReactElement => (
                        <ChainCard key={t.pr.id} item={t} onSelect={onSelect} />
                      ),
                    )}
                  </div>
                </li>
              ),
            )}
          </ol>
        ),
      )}
    </section>
  );
}
