import type { HighlighterCore, LanguageInput } from "shiki/core";

import type { HunkLine } from "./diff";

// GitHub's own themes (same TextMate grammars and colours GitHub uses): light, and dark-dimmed for the dark scheme.
const THEMES = { light: "github-light", dark: "github-dark-dimmed" };
// Big generated files highlight slowly and say little; past this they stay plain.
const MAX_HIGHLIGHT_LINES = 3000;

type Loader = () => Promise<{ default: LanguageInput }>;

// Static imports so Vite splits one chunk per grammar and loads it only when a file of that kind shows up.
const LANGS: Record<string, [string, Loader]> = {
  ts: ["typescript", () => import("shiki/dist/langs/typescript.mjs")],
  mts: ["typescript", () => import("shiki/dist/langs/typescript.mjs")],
  cts: ["typescript", () => import("shiki/dist/langs/typescript.mjs")],
  tsx: ["tsx", () => import("shiki/dist/langs/tsx.mjs")],
  js: ["javascript", () => import("shiki/dist/langs/javascript.mjs")],
  mjs: ["javascript", () => import("shiki/dist/langs/javascript.mjs")],
  cjs: ["javascript", () => import("shiki/dist/langs/javascript.mjs")],
  jsx: ["jsx", () => import("shiki/dist/langs/jsx.mjs")],
  json: ["json", () => import("shiki/dist/langs/json.mjs")],
  css: ["css", () => import("shiki/dist/langs/css.mjs")],
  scss: ["scss", () => import("shiki/dist/langs/scss.mjs")],
  html: ["html", () => import("shiki/dist/langs/html.mjs")],
  vue: ["vue", () => import("shiki/dist/langs/vue.mjs")],
  svelte: ["svelte", () => import("shiki/dist/langs/svelte.mjs")],
  md: ["markdown", () => import("shiki/dist/langs/markdown.mjs")],
  rs: ["rust", () => import("shiki/dist/langs/rust.mjs")],
  go: ["go", () => import("shiki/dist/langs/go.mjs")],
  py: ["python", () => import("shiki/dist/langs/python.mjs")],
  rb: ["ruby", () => import("shiki/dist/langs/ruby.mjs")],
  java: ["java", () => import("shiki/dist/langs/java.mjs")],
  kt: ["kotlin", () => import("shiki/dist/langs/kotlin.mjs")],
  swift: ["swift", () => import("shiki/dist/langs/swift.mjs")],
  cs: ["csharp", () => import("shiki/dist/langs/csharp.mjs")],
  php: ["php", () => import("shiki/dist/langs/php.mjs")],
  c: ["c", () => import("shiki/dist/langs/c.mjs")],
  h: ["c", () => import("shiki/dist/langs/c.mjs")],
  cpp: ["cpp", () => import("shiki/dist/langs/cpp.mjs")],
  sql: ["sql", () => import("shiki/dist/langs/sql.mjs")],
  sh: ["shellscript", () => import("shiki/dist/langs/shellscript.mjs")],
  bash: ["shellscript", () => import("shiki/dist/langs/shellscript.mjs")],
  yml: ["yaml", () => import("shiki/dist/langs/yaml.mjs")],
  yaml: ["yaml", () => import("shiki/dist/langs/yaml.mjs")],
  toml: ["toml", () => import("shiki/dist/langs/toml.mjs")],
  prisma: ["prisma", () => import("shiki/dist/langs/prisma.mjs")],
  graphql: ["graphql", () => import("shiki/dist/langs/graphql.mjs")],
  dockerfile: ["docker", () => import("shiki/dist/langs/docker.mjs")],
};

let highlighter: Promise<HighlighterCore> | null = null;

async function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async (): Promise<HighlighterCore> => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/dist/themes/github-light.mjs"),
      import("shiki/dist/themes/github-dark-dimmed.mjs"),
    ]);
    // The JS regex engine avoids WebAssembly, which the app's CSP does not allow.
    return await createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return await highlighter;
}

/** "src/app/Button.tsx" → its grammar entry; Dockerfiles go by name. */
export function languageOf(path: string): [string, Loader] | null {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return LANGS.dockerfile ?? null;
  const ext = name.includes(".") ? name.split(".").at(-1) : undefined;
  return ext === undefined ? null : (LANGS[ext] ?? null);
}

/** A token with its colour in each scheme; the stylesheet picks one (see .code-tok). */
export interface Token {
  content: string;
  light: string | undefined;
  dark: string | undefined;
  fontStyle: number | undefined;
}

async function tokenize(code: string, path: string): Promise<Token[][] | null> {
  const lang = languageOf(path);
  if (lang === null) return null;
  const hl = await getHighlighter();
  const [id, load] = lang;
  if (!hl.getLoadedLanguages().includes(id)) await hl.loadLanguage((await load()).default);
  return hl.codeToTokensWithThemes(code, { lang: id, themes: THEMES }).map((line): Token[] =>
    line.map(
      (t): Token => ({
        content: t.content,
        light: t.variants.light?.color,
        dark: t.variants.dark?.color,
        fontStyle: t.variants.light?.fontStyle,
      }),
    ),
  );
}

/**
 * Tokens for each diff line, indexed like `lines`. Each side is highlighted as one block (context plus its own
 * lines), so strings and comments that span lines keep their colors. Null when the language is unknown.
 */
export async function highlightDiff(lines: HunkLine[], path: string): Promise<(Token[] | null)[] | null> {
  if (lines.length > MAX_HIGHLIGHT_LINES || languageOf(path) === null) return null;
  const newSide = lines.flatMap((l, i): number[] => (l.kind === "ctx" || l.kind === "add" ? [i] : []));
  const oldSide = lines.flatMap((l, i): number[] => (l.kind === "del" ? [i] : []));
  const oldBlock = lines.flatMap((l, i): number[] => (l.kind === "ctx" || l.kind === "del" ? [i] : []));
  const [fresh, stale] = await Promise.all([
    tokenize(newSide.map((i): string => lines[i]?.text ?? "").join("\n"), path),
    oldSide.length === 0
      ? Promise.resolve(null)
      : tokenize(oldBlock.map((i): string => lines[i]?.text ?? "").join("\n"), path),
  ]);
  if (fresh === null) return null;
  const out: (Token[] | null)[] = lines.map((): null => null);
  newSide.forEach((lineIndex, k): void => {
    out[lineIndex] = fresh[k] ?? null;
  });
  if (stale !== null) {
    oldBlock.forEach((lineIndex, k): void => {
      if (lines[lineIndex]?.kind === "del") out[lineIndex] = stale[k] ?? null;
    });
  }
  return out;
}
