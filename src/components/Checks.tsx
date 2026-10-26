import { openUrl } from "@tauri-apps/plugin-opener";
import { Bot, CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, RotateCcw } from "lucide-react";
import type { ReactElement } from "react";

import { type Config, ciPrompt } from "../lib/config";
import { rerunFailedJobs, saveCiLog } from "../lib/ipc";
import type { Check, CheckState, PullDetail, PullRequest } from "../lib/model";
import { useAction } from "./useAction";

const ICON: Record<CheckState, ReactElement> = {
  success: <CircleCheck size={16} strokeWidth={2} aria-hidden />,
  failure: <CircleX size={16} strokeWidth={2} aria-hidden />,
  pending: <CircleDashed size={16} strokeWidth={2} aria-hidden />,
  neutral: <CircleMinus size={16} strokeWidth={2} aria-hidden />,
};

const LABEL: Record<CheckState, string> = {
  success: "passou",
  failure: "falhou",
  pending: "rodando",
  neutral: "neutro",
};

const ORDER: Record<CheckState, number> = { failure: 0, pending: 1, neutral: 2, success: 3 };

export function failedRunIds(checks: Check[]): number[] {
  return [
    ...new Set(
      checks.filter((c): boolean => c.state === "failure" && c.runId !== null).map((c): number => c.runId ?? 0),
    ),
  ];
}

export function ChecksTab({
  pr,
  config,
  detail,
  agentBlocked,
  onAgent,
  onChanged,
}: {
  pr: PullRequest;
  config: Config;
  detail: PullDetail;
  agentBlocked: boolean;
  onAgent: (prompt: string) => void;
  onChanged: () => void;
}): ReactElement {
  const action = useAction();
  const [owner = "", repo = ""] = pr.repo.split("/");
  const checks = [...detail.checks].sort((a, b): number => ORDER[a.state] - ORDER[b.state]);
  const runs = failedRunIds(detail.checks);

  const fix = async (check: Check): Promise<void> => {
    const jobId = check.jobId;
    if (jobId === null) return;
    await action.run(`fix-${jobId}`, async (): Promise<void> => {
      const logPath = await saveCiLog(config.apiUrl, owner, repo, jobId, config.workspaceDir);
      onAgent(ciPrompt(pr, check.name, logPath));
    });
  };

  const rerun = async (): Promise<void> => {
    const ok = await action.run("rerun", async (): Promise<void> => {
      for (const runId of runs) await rerunFailedJobs(config.apiUrl, owner, repo, runId);
    });
    if (ok) onChanged();
  };

  if (checks.length === 0) return <p className="notice">Nenhum check de CI no último commit.</p>;
  return (
    <div className="checks">
      {runs.length > 0 && (
        <div className="checks-bar">
          <button
            type="button"
            className="button small"
            disabled={action.pending !== null}
            onClick={(): void => void rerun()}
          >
            <RotateCcw size={14} strokeWidth={2} aria-hidden />
            {action.pending === "rerun" ? "Pedindo…" : "Re-rodar os jobs que falharam"}
          </button>
        </div>
      )}
      {action.error !== null && (
        <p className="action-error" role="alert">
          {action.error}
        </p>
      )}
      <ul className="check-list">
        {checks.map(
          (c, i): ReactElement => (
            // biome-ignore lint/suspicious/noArrayIndexKey: check names can repeat across workflows
            <li key={`${c.name}-${i}`} className={`check check-${c.state}`}>
              <span className="check-icon">{ICON[c.state]}</span>
              <span className="check-name">{c.name}</span>
              <span className="check-state">{LABEL[c.state]}</span>
              <span className="check-actions">
                {c.state === "failure" && c.jobId !== null && (
                  <button
                    type="button"
                    className="chip-button accent"
                    disabled={agentBlocked || action.pending !== null}
                    title={agentBlocked ? "Já há um agente aberto nesta PR. Encerre-o para iniciar outro." : undefined}
                    onClick={(): void => void fix(c)}
                  >
                    <Bot size={14} strokeWidth={2} aria-hidden />
                    {action.pending === `fix-${c.jobId}` ? "Baixando o log…" : "Corrigir com agente"}
                  </button>
                )}
                {c.url !== null && (
                  <button type="button" className="chip-button" onClick={(): void => void openUrl(c.url ?? "")}>
                    <ExternalLink size={14} strokeWidth={2} aria-hidden /> Detalhes
                  </button>
                )}
              </span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
