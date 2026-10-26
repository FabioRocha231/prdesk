import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import type { ReactElement } from "react";
import { useEffect, useRef } from "react";

import { ptyAttach, ptyResize, ptyWrite } from "../lib/ipc";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function theme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  return {
    background: cssVar("--term-bg"),
    foreground: cssVar("--term-ink"),
    cursor: cssVar("--signal"),
    selectionBackground: cssVar("--term-rule"),
  };
}

function decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c): number => c.charCodeAt(0));
}

/** xterm.js bound to a Rust PTY session. Stays mounted while hidden so scrollback survives switching PRs. */
export function Terminal({
  sessionId,
  visible,
  onExit,
}: {
  sessionId: number;
  visible: boolean;
  onExit: (sessionId: number) => void;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const term = useRef<XTerm | null>(null);

  useEffect((): (() => void) => {
    const el = host.current;
    if (el === null) return (): void => {};
    const xterm = new XTerm({ fontFamily: cssVar("--mono"), fontSize: 12, cursorBlink: true, theme: theme() });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(el);
    term.current = xterm;
    fit.current = fitAddon;

    // Live chunks can race the backlog reply, so they queue until the backlog is written.
    let attached = false;
    const queued: Uint8Array[] = [];
    const unlistenOutput = listen<string>(`pty-output-${sessionId}`, (e): void => {
      const chunk = decode(e.payload);
      if (attached) xterm.write(chunk);
      else queued.push(chunk);
    });
    const unlistenExit = listen(`pty-exit-${sessionId}`, (): void => onExit(sessionId));
    void (async (): Promise<void> => {
      await unlistenOutput;
      xterm.write(decode(await ptyAttach(sessionId)));
      for (const chunk of queued) xterm.write(chunk);
      attached = true;
    })();

    const input = xterm.onData((data): void => {
      void ptyWrite(sessionId, data);
    });

    const resize = new ResizeObserver((): void => {
      if (el.offsetParent === null) return;
      fitAddon.fit();
      void ptyResize(sessionId, xterm.rows, xterm.cols);
    });
    resize.observe(el);

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const retheme = (): void => {
      xterm.options.theme = theme();
    };
    scheme.addEventListener("change", retheme);

    return (): void => {
      scheme.removeEventListener("change", retheme);
      resize.disconnect();
      input.dispose();
      void unlistenOutput.then((off): void => off());
      void unlistenExit.then((off): void => off());
      xterm.dispose();
    };
  }, [sessionId, onExit]);

  useEffect((): void => {
    if (!visible) return;
    fit.current?.fit();
    term.current?.focus();
  }, [visible]);

  return <div className="term-host" ref={host} hidden={!visible} />;
}
