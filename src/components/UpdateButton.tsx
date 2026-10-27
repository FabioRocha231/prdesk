import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Download } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { errorMessage } from "../lib/ipc";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Shows up in the header when a newer release is out: downloads it, installs it and restarts prdesk. */
export function UpdateButton(): ReactElement | null {
  const [update, setUpdate] = useState<Update | null>(null);
  // Share of the download done, while it runs.
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect((): (() => void) => {
    let alive = true;
    const look = (): void => {
      check()
        .then((found): void => {
          if (alive) setUpdate(found);
        })
        .catch((): void => {
          // Offline, or no release reachable: the next check tries again.
        });
    };
    look();
    const timer = window.setInterval(look, CHECK_EVERY_MS);
    return (): void => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

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
