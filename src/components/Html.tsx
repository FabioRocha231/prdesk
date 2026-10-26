import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";
import type { MouseEvent, ReactElement } from "react";
import { useMemo } from "react";

/** Opens links in the system browser instead of navigating the app window. */
async function openLink(event: MouseEvent<HTMLDivElement>): Promise<void> {
  const anchor = (event.target as HTMLElement).closest("a");
  if (anchor === null) return;
  event.preventDefault();
  if (anchor.href.startsWith("https://")) await openUrl(anchor.href);
}

/** GitHub's server-rendered HTML, sanitized again because it ends up next to a shell. */
export function Html({ html }: { html: string }): ReactElement {
  const clean = useMemo((): string => DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input"] }), [html]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: delegated link handler; links stay keyboard-focusable
    <div
      className="markdown"
      onClick={(e): void => {
        void openLink(e);
      }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
