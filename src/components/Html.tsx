import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";
import type { MouseEvent, ReactElement } from "react";
import { useEffect, useMemo, useRef } from "react";

/** Opens links in the system browser instead of navigating the app window. */
async function openLink(event: MouseEvent<HTMLDivElement>): Promise<void> {
  const anchor = (event.target as HTMLElement).closest("a");
  if (anchor === null) return;
  event.preventDefault();
  if (anchor.href.startsWith("https://")) await openUrl(anchor.href);
}

let diagrams = 0;

/**
 * GitHub ships mermaid as a code block that its own page script draws; here mermaid (loaded only when a diagram
 * shows up) draws it instead. Strict mode and plain SVG labels keep the output free of HTML and handlers.
 */
async function drawDiagrams(root: HTMLElement, isLive: () => boolean): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre[lang="mermaid"]')];
  if (blocks.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
    htmlLabels: false,
  });
  // One at a time: mermaid renders through a shared scratch element.
  for (const pre of blocks) {
    try {
      diagrams += 1;
      const { svg } = await mermaid.render(`mermaid-${diagrams}`, pre.textContent ?? "");
      if (!isLive()) return;
      const figure = document.createElement("div");
      figure.className = "mermaid-diagram";
      figure.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      (pre.closest('section[data-type="mermaid"]') ?? pre).replaceWith(figure);
    } catch (e) {
      // Degraded: a diagram mermaid cannot parse stays as its source code.
      console.warn("[Html.drawDiagrams] mermaid failed", e);
    }
  }
}

/** GitHub's server-rendered HTML, sanitized again because it ends up next to a shell. */
export function Html({ html }: { html: string }): ReactElement {
  const clean = useMemo((): string => DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input"] }), [html]);
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new HTML replaces the drawn diagrams, so they are drawn again
  useEffect((): (() => void) | undefined => {
    if (ref.current === null) return undefined;
    let live = true;
    void drawDiagrams(ref.current, (): boolean => live);
    return (): void => {
      live = false;
    };
  }, [clean]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: delegated link handler; links stay keyboard-focusable
    <div
      ref={ref}
      className="markdown"
      onClick={(e): void => {
        void openLink(e);
      }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
