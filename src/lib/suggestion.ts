/** The replacement inside a review comment's ```suggestion block; "" deletes the lines, null means no suggestion. */
export function parseSuggestion(body: string): string | null {
  const match = /```suggestion[^\n]*\n([\s\S]*?)```/.exec(body.replace(/\r\n/g, "\n"));
  if (match === null) return null;
  return (match[1] ?? "").replace(/\n$/, "");
}

/** Replaces lines `start`..`end` (1-based, inclusive) of `text`, keeping its line endings. */
export function applySuggestion(text: string, start: number, end: number, replacement: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (start < 1 || end < start || end > lines.length)
    throw new Error("A sugestão aponta para linhas que não existem mais.");
  const added = replacement === "" ? [] : replacement.split("\n");
  return [...lines.slice(0, start - 1), ...added, ...lines.slice(end)].join(eol);
}

/** GitHub's contents API speaks base64 of the raw bytes; these keep UTF-8 intact both ways. */
export function fromBase64(b64: string): string {
  const binary = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (c): number => c.charCodeAt(0)));
}

export function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
