import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Download, RefreshCw } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "../lib/ipc";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
// Coming back to the window looks again, at most this often: a release is found the same day, not hours later.
const FOCUS_GAP_MS = 15 * 60 * 1000;

export interface UpdateCheck {
  /** The installed version; null until read. */
  version: string | null;
  update: Update | null;
  checking: boolean;
  /** Why the last check failed; a silent failure used to look exactly like "up to date". */
  error: string | null;
  checkedAt: number | null;
  check: () => Promise<void>;
}

/** Looks for a newer release at launch, every few hours and when the window comes back into focus. */
export function useUpdateCheck(): UpdateCheck {
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const last = useRef(0);

  const look = useCallback(async (): Promise<void> => {
    last.current = Date.now();
    setChecking(true);
    try {
      setUpdate(await check());
      setError(null);
    } catch (e) {
      console.warn("[useUpdateCheck] update check failed", e);
      setError(errorMessage(e));
    } finally {
      setChecking(false);
      setCheckedAt(Date.now());
    }
  }, []);

  useEffect((): (() => void) => {
    getVersion().then(setVersion, (): void => {});
    void look();
    const timer = window.setInterval((): void => void look(), CHECK_EVERY_MS);
    const onFocus = (): void => {
      if (Date.now() - last.current >= FOCUS_GAP_MS) void look();
    };
    window.addEventListener("focus", onFocus);
    return (): void => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [look]);

  return { version, update, checking, error, checkedAt, check: look };
}

/** Shows up in the sidebar when a newer release is out: downloads it, installs it and restarts prdesk. */
export function UpdateButton({ update }: { update: Update | null }): ReactElement | null {
  // Share of the download done, while it runs.
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (update === null) return null;

  const install = async (): Promise<void> => {
    setError(null);
    setProgress(0);
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((e): void => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress") {
          done += e.data.chunkLength;
          if (total > 0) setProgress(done / total);
        }
      });
      await relaunch();
    } catch (e) {
      setProgress(null);
      setError(errorMessage(e));
    }
  };

  const label =
    progress !== null ? `${Math.round(progress * 100)}%` : error === null ? update.version : "Tentar de novo";
  return (
    <button
      type="button"
      className="update-button"
      disabled={progress !== null}
      aria-label={progress === null ? `Atualizar para ${update.version}` : undefined}
      title={error ?? `Atualizar para ${update.version}: baixa, instala e reinicia o prdesk`}
      onClick={(): void => void install()}
    >
      <Download size={15} strokeWidth={2} aria-hidden /> {label}
    </button>
  );
}

/** The Ajustes line: installed version, the last check's answer, and a way to look now. */
export function UpdateStatus({ updates }: { updates: UpdateCheck }): ReactElement {
  const { version, update, checking, error, checkedAt } = updates;
  const answer = checking
    ? "Procurando…"
    : error !== null
      ? `Não deu para procurar: ${error}`
      : update !== null
        ? `A versão ${update.version} está disponível: use o botão verde na barra lateral.`
        : checkedAt !== null
          ? "Você está na versão mais recente."
          : "";
  return (
    <div className="field-body">
      <div className="inline">
        <span>prdesk {version ?? "…"}</span>
        <button type="button" className="button small" disabled={checking} onClick={(): void => void updates.check()}>
          <RefreshCw size={14} strokeWidth={2} aria-hidden /> Procurar atualização
        </button>
      </div>
      {answer !== "" && (
        <p className={error === null ? "hint" : "hint action-error"} role={error === null ? "status" : "alert"}>
          {answer}
        </p>
      )}
    </div>
  );
}
