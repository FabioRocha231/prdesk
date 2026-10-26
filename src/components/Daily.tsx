import { CalendarCheck, Copy } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { Config } from "../lib/config";
import { age } from "../lib/format";
import { type Daily, type DailyItem, fetchDaily } from "../lib/github";
import { errorMessage } from "../lib/ipc";
import type { TriagedPull } from "../lib/model";

const MONDAY = 1;
const FRIDAY_GAP = 3;
const BLOCKED_DAYS = 2;
const DAY_MS = 86_400_000;

/** The previous workday as YYYY-MM-DD: Friday on Mondays, yesterday otherwise. */
export function previousWorkday(now: Date): string {
  const d = new Date(now);
  d.setDate(d.getDate() - (d.getDay() === MONDAY ? FRIDAY_GAP : 1));
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** My PRs that have been waiting on others for a while: the blockers worth saying out loud. */
export function blockers(waiting: TriagedPull[], now: number): TriagedPull[] {
  return waiting.filter((i): boolean => {
    const since = i.triage.at ?? i.pr.updatedAt;
    return !i.pr.isDraft && now - Date.parse(since) > BLOCKED_DAYS * DAY_MS;
  });
}

function line(i: DailyItem): string {
  return `- ${i.repo}#${i.number} ${i.title}`;
}

/** Plain text ready to paste in the stand-up channel. */
export function standupText(daily: Daily, blocked: TriagedPull[]): string {
  const section = (title: string, items: string[]): string[] => (items.length === 0 ? [] : [title, ...items, ""]);
  const text = [
    ...section("Mergeei:", daily.merged.map(line)),
    ...section("Abri:", daily.opened.map(line)),
    ...section("Revisei:", daily.reviewed.map(line)),
    ...section(
      "Travado esperando review:",
      blocked.map((b): string => `- ${b.pr.repo}#${b.pr.number} ${b.pr.title} (${age(b.triage.at ?? b.pr.updatedAt)})`),
    ),
  ];
  return text.length === 0 ? "Nada de PR desde o último dia útil." : text.join("\n").trim();
}

export function DailyDialog({
  config,
  waiting,
  onClose,
}: {
  config: Config;
  waiting: TriagedPull[];
  onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [daily, setDaily] = useState<Daily | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const since = previousWorkday(new Date());
  const blocked = blockers(waiting, Date.now());

  useEffect((): void => {
    dialog.current?.showModal();
  }, []);

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        setDaily(await fetchDaily(config, since));
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, [config, since]);

  const text = daily === null ? "" : standupText(daily, blocked);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (e) {
      setError(`Não deu para copiar: ${errorMessage(e)}`);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Esc closes the dialog natively
    <dialog
      ref={dialog}
      className="palette daily"
      aria-label="Resumo do dia"
      onClose={onClose}
      onClick={(e): void => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="palette-input">
        <CalendarCheck size={18} strokeWidth={2} aria-hidden />
        <span className="feed-heading">Daily · desde {since.split("-").reverse().join("/")}</span>
        <kbd>Esc</kbd>
      </div>
      <div className="daily-body">
        {error !== null && (
          <p className="action-error" role="alert">
            {error}
          </p>
        )}
        {daily === null && error === null && <div className="skeleton" role="status" aria-label="Carregando" />}
        {daily !== null && (
          <>
            <pre className="daily-text">{text}</pre>
            <button type="button" className="button primary small" onClick={(): void => void copy()}>
              <Copy size={14} strokeWidth={2} aria-hidden /> {copied ? "Copiado" : "Copiar para a daily"}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
