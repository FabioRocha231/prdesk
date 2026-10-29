import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Bot,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  ExternalLink,
  RotateCcw,
  ScrollText,
} from "lucide-react";
import { type ReactElement, useState } from "react";

import { type Config, ciPrompt } from "../lib/config";
import { ciLog, rerunFailedJobs, saveCiLog } from "../lib/ipc";
import type { Check, CheckState, PullRequest } from "../lib/model";
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

/** GitHub prefixes every log line with a timestamp and keeps the terminal colours; neither reads well here. */
export function cleanLog(log: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is what ANSI colour codes start with
  return log.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/gm, "").replace(/\x1b\[[\d;]*m/g, "");
}

export function failedRunIds(checks: Check[]): number[] {
  return [
    ...new Set(
      checks.filter((c): boolean => c.state === "failure" && c.runId !== null).map((c): number => c.runId ?? 0),
    ),
  ];
}

/** A PR's checks, or a branch's (`agent` null): there is no PR then to hand the fix to. */
export function ChecksTab({
  config,
  repo: fullName,
  checks: all,
  agent,
  onChanged,
}: {
  config: Config;
  repo: string;
  checks: Check[];
  agent: { pr: PullRequest; blocked: boolean; onAgent: (prompt: string) => void } | null;
  onChanged: () => void;
}): ReactElement {
  const action = useAction();
  const [owner = "", repo = ""] = fullName.split("/");
  const checks = [...all].sort((a, b): number => ORDER[a.state] - ORDER[b.state]);
  const runs = failedRunIds(all);
  // Job id → its log tail, once loaded; the open one shows under its check.
  const [logs, setLogs] = useState<ReadonlyMap<number, string>>(new Map());
  const [openLog, setOpenLog] = useState<number | null>(null);

  const fix = async (check: Check): Promise<void> => {
    const jobId = check.jobId;
    if (jobId === null || agent === null) return;
    await action.run(`fix-${jobId}`, async (): Promise<void> => {
      const logPath = await saveCiLog(config.apiUrl, owner, repo, jobId, config.workspaceDir);
      agent.onAgent(ciPrompt(agent.pr, check.name, logPath));
    });
  };

  const toggleLog = async (jobId: number): Promise<void> => {
    if (openLog === jobId) return setOpenLog(null);
    if (!logs.has(jobId)) {
      let log = "";
      const ok = await action.run(`log-${jobId}`, async (): Promise<void> => {
        log = cleanLog(await ciLog(config.apiUrl, owner, repo, jobId));
      });
      if (!ok) return;
      setLogs((all): ReadonlyMap<number, string> => new Map(all).set(jobId, log));
    }
    setOpenLog(jobId);
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
                {agent !== null && c.state === "failure" && c.jobId !== null && (
                  <button
                    type="button"
                    className="chip-button accent"
                    disabled={agent.blocked || action.pending !== null}
                    title={agent.blocked ? "Já há um agente aberto nesta PR. Encerre-o para iniciar outro." : undefined}
                    onClick={(): void => void fix(c)}
                  >
                    <Bot size={14} strokeWidth={2} aria-hidden />
                    {action.pending === `fix-${c.jobId}` ? "Baixando o log…" : "Corrigir com agente"}
                  </button>
                )}
                {c.state === "failure" && c.jobId !== null && (
                  <button
                    type="button"
                    className="chip-button"
                    aria-expanded={openLog === c.jobId}
                    disabled={action.pending !== null}
                    onClick={(): void => void toggleLog(c.jobId ?? 0)}
                  >
                    <ScrollText size={14} strokeWidth={2} aria-hidden />
                    {action.pending === `log-${c.jobId}`
                      ? "Baixando…"
                      : openLog === c.jobId
                        ? "Esconder log"
                        : "Ver log"}
                  </button>
                )}
                {c.url !== null && (
                  <button type="button" className="chip-button" onClick={(): void => void openUrl(c.url ?? "")}>
                    <ExternalLink size={14} strokeWidth={2} aria-hidden /> Detalhes
                  </button>
                )}
              </span>
              {c.jobId !== null && openLog === c.jobId && (
                <pre className="check-log" ref={(el): void => el?.scrollTo(0, el.scrollHeight)}>
                  {logs.get(c.jobId)}
                </pre>
              )}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
