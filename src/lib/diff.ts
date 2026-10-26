export type LineKind = "add" | "del" | "ctx" | "meta";

export interface HunkLine {
  kind: LineKind;
  text: string;
  /** Line number on the new side; null for removed lines and headers. */
  newNo: number | null;
  /** Line number on the old side; null for added lines and headers. */
  oldNo: number | null;
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Numbers each line of a unified-diff hunk (GitHub's `diffHunk`) from its `@@` header. */
export function numberHunk(hunk: string): HunkLine[] {
  let oldNo = 0;
  let newNo = 0;
  return hunk.split("\n").map((raw): HunkLine => {
    const header = HEADER.exec(raw);
    if (header !== null) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      return { kind: "meta", text: raw, newNo: null, oldNo: null };
    }
    // "\ No newline at end of file" annotates the previous line; it is not a line of either side.
    if (raw.startsWith("\\")) return { kind: "meta", text: raw, newNo: null, oldNo: null };
    const text = raw.slice(1);
    if (raw.startsWith("+")) return { kind: "add", text, newNo: newNo++, oldNo: null };
    if (raw.startsWith("-")) return { kind: "del", text, newNo: null, oldNo: oldNo++ };
    return { kind: "ctx", text, newNo: newNo++, oldNo: oldNo++ };
  });
}
