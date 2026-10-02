import { StreamLanguage, type StreamParser } from "@codemirror/language";

/** Terraform / HCL highlighting: blocks, attributes, strings with ${…}, heredocs, comments. */
type State = { heredoc: string | null; comment: boolean; interp: number };

const BLOCKS = new Set([
  "resource", "data", "variable", "output", "module", "provider", "terraform", "locals", "moved", "import", "check",
  "removed", "backend", "required_providers", "dynamic", "content", "lifecycle", "provisioner", "connection", "validation",
]);
const ATOMS = new Set(["true", "false", "null"]);
const KEYWORDS = new Set(["for", "in", "if", "else", "endif", "endfor"]);
const REFS = new Set(["var", "local", "module", "data", "path", "terraform", "count", "each", "self"]);

const parser: StreamParser<State> = {
  name: "hcl",
  startState: () => ({ heredoc: null, comment: false, interp: 0 }),
  token(stream, state) {
    if (state.heredoc) {
      if (stream.sol() && stream.match(new RegExp(`^\\s*${state.heredoc}\\s*$`))) {
        state.heredoc = null;
        return "string";
      }
      stream.skipToEnd();
      return "string";
    }
    if (state.comment) {
      if (stream.match(/.*?\*\//)) state.comment = false;
      else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("#") || stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/*")) { state.comment = true; return "comment"; }
    const here = stream.match(/^<<-?([A-Za-z_][\w]*)/) as RegExpMatchArray | null;
    if (here) { state.heredoc = here[1]; return "string"; }
    if (stream.peek() === '"') {
      stream.next();
      // a string ends at an unescaped quote; ${…} stays part of it (good enough for colouring)
      let depth = 0;
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\") { stream.next(); continue; }
        if (ch === "$" && stream.peek() === "{") { depth++; stream.next(); continue; }
        if (ch === "}" && depth > 0) { depth--; continue; }
        if (ch === '"' && depth === 0) break;
      }
      return "string";
    }
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^(==|!=|<=|>=|&&|\|\||=>|[=<>!?:+\-*/%])/)) return "operator";
    const word = stream.match(/^[A-Za-z_][\w-]*/) as RegExpMatchArray | null;
    if (word) {
      const w = word[0];
      if (ATOMS.has(w)) return "atom";
      if (KEYWORDS.has(w)) return "keyword";
      // block type at the start of a line: resource "aws_instance" "web" {
      const before = stream.string.slice(0, stream.start).trim();
      if (before === "" && BLOCKS.has(w) && /^\s*("|\{|[A-Za-z_])/.test(stream.string.slice(stream.pos))) return "keyword";
      if (/^\s*=(?!=)/.test(stream.string.slice(stream.pos))) return "propertyName";
      if (/^\s*\(/.test(stream.string.slice(stream.pos))) return "function(variableName)";
      if (REFS.has(w) && stream.peek() === ".") return "variableName.special";
      if (before === "" && /^\s*\{/.test(stream.string.slice(stream.pos))) return "typeName";
      return "variableName";
    }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#", block: { open: "/*", close: "*/" } } },
};

export const hcl = () => StreamLanguage.define(parser);

/** Fallback check when terraform isn't installed: unbalanced braces/brackets and unterminated strings. */
export function hclBalance(text: string): { line: number; message: string }[] {
  const out: { line: number; message: string }[] = [];
  const stack: { ch: string; line: number }[] = [];
  const pairs: Record<string, string> = { "}": "{", "]": "[", ")": "(" };
  let line = 1, inStr = false, strLine = 0, heredoc: string | null = null, block = false;
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++, line++) {
    const l = lines[li];
    if (heredoc) { if (l.trim() === heredoc) heredoc = null; continue; }
    for (let i = 0; i < l.length; i++) {
      const c = l[i], n = l[i + 1];
      if (block) { if (c === "*" && n === "/") { block = false; i++; } continue; }
      if (inStr) {
        if (c === "\\") { i++; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === "#" || (c === "/" && n === "/")) break;
      if (c === "/" && n === "*") { block = true; i++; continue; }
      if (c === "<" && n === "<") { const m = /^<<-?([A-Za-z_]\w*)/.exec(l.slice(i)); if (m) { heredoc = m[1]; break; } }
      if (c === '"') { inStr = true; strLine = line; continue; }
      if ("{[(".includes(c)) stack.push({ ch: c, line });
      else if (pairs[c]) {
        const top = stack.pop();
        if (!top || top.ch !== pairs[c]) out.push({ line, message: `лишняя «${c}»` });
      }
    }
    if (inStr) { out.push({ line: strLine, message: "не закрыта кавычка" }); inStr = false; }
  }
  for (const s of stack) out.push({ line: s.line, message: `не закрыта «${s.ch}»` });
  if (heredoc) out.push({ line: lines.length, message: `heredoc <<${heredoc} не закрыт` });
  return out;
}
