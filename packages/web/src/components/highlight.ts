/**
 * Tiny syntax tokenizers for curl (shell), TypeScript, and JSON.
 *
 * Pure functions — server-side renderable, no JS dependency on the
 * client. Just enough to color the snippets in the docs; a real
 * highlighter (Shiki, Prism, etc.) would be overkill.
 */

type TokenKind =
  | "default"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "command"
  | "flag"
  | "prompt"
  | "punct"
  | "key"
  | "value-const";

type Token = { kind: TokenKind; text: string };

export type Lang = "curl" | "ts" | "json";

// Tailwind classes mapped per kind. `default` returns no span; we render
// the raw text so it picks up the parent <pre> color.
export const TOKEN_COLOR: Record<TokenKind, string | null> = {
  default: null,
  comment: "text-[var(--color-bone-fade)]",
  string: "text-[var(--color-tide)]",
  number: "text-[var(--color-tide)]",
  keyword: "text-[var(--color-marker)]",
  command: "text-[var(--color-marker)]",
  flag: "text-[var(--color-bone-dim)]",
  prompt: "text-[var(--color-bone-fade)]",
  punct: "text-[var(--color-bone-dim)]",
  key: "text-[var(--color-marker)]",
  "value-const": "text-[var(--color-bone-dim)]",
};

// ─── shared scanners ──────────────────────────────────────────────────────

const isDigit = (c: string) => c >= "0" && c <= "9";
const isAlpha = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isIdent = (c: string) => isAlpha(c) || isDigit(c) || c === "-";

const scanString = (src: string, i: number, quote: string): number => {
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === "\\" && j + 1 < src.length) j += 2;
    else j++;
  }
  return Math.min(j + 1, src.length);
};

const scanNumber = (src: string, i: number): number => {
  let j = i;
  if (src[j] === "-") j++;
  while (j < src.length && (isDigit(src[j]!) || src[j] === ".")) j++;
  if (src[j] === "e" || src[j] === "E") {
    j++;
    if (src[j] === "+" || src[j] === "-") j++;
    while (j < src.length && isDigit(src[j]!)) j++;
  }
  return j;
};

// ─── curl / shell ─────────────────────────────────────────────────────────

const SHELL_COMMANDS = new Set([
  "curl",
  "git",
  "cd",
  "echo",
  "docker",
  "compose",
  "bun",
  "npm",
  "node",
  "yarn",
  "pnpm",
  "cat",
  "ls",
  "mkdir",
  "rm",
  "mv",
  "cp",
  "touch",
]);

const tokenizeShell = (src: string): Token[] => {
  const out: Token[] = [];
  let i = 0;
  let atLineStart = true;

  while (i < src.length) {
    const c = src[i]!;

    if (c === "\n") {
      out.push({ kind: "default", text: c });
      atLineStart = true;
      i++;
      continue;
    }

    if (c === " " || c === "\t") {
      out.push({ kind: "default", text: c });
      i++;
      continue;
    }

    // line-start prompt: $
    if (atLineStart && c === "$") {
      out.push({ kind: "prompt", text: c });
      atLineStart = false;
      i++;
      continue;
    }

    // line-start comment: # ...
    if (atLineStart && c === "#") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      out.push({ kind: "comment", text: src.slice(i, j) });
      i = j;
      atLineStart = false;
      continue;
    }

    // string: '...' or "..."
    if (c === "'" || c === '"') {
      const end = scanString(src, i, c);
      out.push({ kind: "string", text: src.slice(i, end) });
      i = end;
      atLineStart = false;
      continue;
    }

    // flag: -X, --header, ...
    if (c === "-" && (src[i + 1] === "-" || isAlpha(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && (isIdent(src[j]!) || src[j] === "-")) j++;
      out.push({ kind: "flag", text: src.slice(i, j) });
      i = j;
      atLineStart = false;
      continue;
    }

    // word — possibly a command
    if (isAlpha(c)) {
      let j = i;
      while (j < src.length && isIdent(src[j]!)) j++;
      const word = src.slice(i, j);
      out.push({
        kind: SHELL_COMMANDS.has(word) ? "command" : "default",
        text: word,
      });
      i = j;
      atLineStart = false;
      continue;
    }

    // anything else
    out.push({ kind: "default", text: c });
    i++;
    atLineStart = false;
  }
  return out;
};

// ─── typescript ───────────────────────────────────────────────────────────

const TS_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "async",
  "await",
  "import",
  "from",
  "export",
  "default",
  "class",
  "new",
  "this",
  "type",
  "interface",
  "as",
  "in",
  "of",
  "throw",
  "try",
  "catch",
  "finally",
]);

const TS_CONSTS = new Set(["true", "false", "null", "undefined"]);

const tokenizeTs = (src: string): Token[] => {
  const out: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;

    // line comment
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      out.push({ kind: "comment", text: src.slice(i, j) });
      i = j;
      continue;
    }

    // block comment
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(j + 2, src.length);
      out.push({ kind: "comment", text: src.slice(i, j) });
      i = j;
      continue;
    }

    // string (', ", `)
    if (c === "'" || c === '"' || c === "`") {
      const end = scanString(src, i, c);
      out.push({ kind: "string", text: src.slice(i, end) });
      i = end;
      continue;
    }

    // number
    if (isDigit(c) || (c === "-" && isDigit(src[i + 1] ?? ""))) {
      const end = scanNumber(src, i);
      out.push({ kind: "number", text: src.slice(i, end) });
      i = end;
      continue;
    }

    // identifier / keyword
    if (isAlpha(c)) {
      let j = i;
      while (j < src.length && (isAlpha(src[j]!) || isDigit(src[j]!))) j++;
      const word = src.slice(i, j);
      const kind: TokenKind = TS_KEYWORDS.has(word)
        ? "keyword"
        : TS_CONSTS.has(word)
          ? "value-const"
          : "default";
      out.push({ kind, text: word });
      i = j;
      continue;
    }

    // punctuation
    if ("(){}[],;.:=<>?!+-*/&|^~%".includes(c)) {
      out.push({ kind: "punct", text: c });
      i++;
      continue;
    }

    // anything else (whitespace, etc.)
    out.push({ kind: "default", text: c });
    i++;
  }
  return out;
};

// ─── json (with // line comments tolerated, JSONC style) ──────────────────

const tokenizeJson = (src: string): Token[] => {
  const out: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;

    // line comment
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      out.push({ kind: "comment", text: src.slice(i, j) });
      i = j;
      continue;
    }

    // string — peek ahead to see if it's a key (followed by :)
    if (c === '"') {
      const end = scanString(src, i, '"');
      let k = end;
      while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
      const isKey = src[k] === ":";
      out.push({ kind: isKey ? "key" : "string", text: src.slice(i, end) });
      i = end;
      continue;
    }

    // number
    if (isDigit(c) || (c === "-" && isDigit(src[i + 1] ?? ""))) {
      const end = scanNumber(src, i);
      out.push({ kind: "number", text: src.slice(i, end) });
      i = end;
      continue;
    }

    // const: true / false / null
    if (src.startsWith("true", i)) {
      out.push({ kind: "value-const", text: "true" });
      i += 4;
      continue;
    }
    if (src.startsWith("false", i)) {
      out.push({ kind: "value-const", text: "false" });
      i += 5;
      continue;
    }
    if (src.startsWith("null", i)) {
      out.push({ kind: "value-const", text: "null" });
      i += 4;
      continue;
    }

    // punctuation
    if ("{}[],:".includes(c)) {
      out.push({ kind: "punct", text: c });
      i++;
      continue;
    }

    // whitespace / anything else
    out.push({ kind: "default", text: c });
    i++;
  }
  return out;
};

// ─── public ───────────────────────────────────────────────────────────────

export const tokenize = (lang: Lang, source: string): Token[] => {
  if (lang === "curl") return tokenizeShell(source);
  if (lang === "ts") return tokenizeTs(source);
  return tokenizeJson(source);
};
