import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import type { HunkLine } from "../lib/diff";
import { highlightDiff, type Token } from "../lib/highlight";

const ITALIC = 1;

/** Syntax tokens for diff lines, filled in once the grammar loads; plain text until then or when unknown. */
export function useDiffTokens(lines: HunkLine[], path: string | undefined): (Token[] | null)[] | null {
  const [tokens, setTokens] = useState<(Token[] | null)[] | null>(null);
  // The joined text is the stable identity; `lines` is a new array on every render.
  const key = lines.map((l): string => `${l.kind}${l.text}`).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands in for `lines`, which changes identity each render
  useEffect((): (() => void) => {
    let live = true;
    setTokens(null);
    if (path !== undefined) {
      highlightDiff(lines, path)
        .then((t): void => {
          if (live) setTokens(t);
        })
        .catch((): void => {
          // Degraded: a grammar failed to load; the diff stays plain text.
        });
    }
    return (): void => {
      live = false;
    };
  }, [key, path]);
  return tokens;
}

/** One line of code, colored when tokens are available. */
export function CodeText({ text, tokens }: { text: string; tokens: Token[] | null | undefined }): ReactElement {
  if (tokens == null || tokens.length === 0) return <code>{text === "" ? " " : text}</code>;
  return (
    <code>
      {tokens.map(
        (t, i): ReactElement => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens of a line are static
          <span key={i} style={{ color: t.color, fontStyle: (t.fontStyle ?? 0) & ITALIC ? "italic" : undefined }}>
            {t.content}
          </span>
        ),
      )}
    </code>
  );
}
