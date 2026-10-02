#!/usr/bin/env node
// Lists Russian UI strings in the sources and which of them have no English translation yet.
//   node scripts/i18n-extract.mjs            → summary + untranslated keys
//   node scripts/i18n-extract.mjs --json     → JSON array of all keys (for building the dictionary)
// A key is a Russian fragment as it appears in the UI: text between tags, an attribute value, or a
// string literal; `${…}` inside a template becomes a {placeholder}.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CYR = /[А-Яа-яЁё]/;
const files = [
  "src/main.ts",
  ...readdirSync("src/modules").filter((f) => f.endsWith(".ts") && f !== "help.ts" && f !== "help-en.ts").map((f) => join("src/modules", f)),
  ...readdirSync("src-tauri/src").filter((f) => f.endsWith(".rs")).map((f) => join("src-tauri/src", f)),
];

const keys = new Map(); // key → first location

function add(raw, where) {
  let s = raw
    .replace(/\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "{}") // ${expr} → {}
    .replace(/\{[a-z_][a-z0-9_]*(:[^}]*)?\}/gi, "{}") // Rust format!("{name}") → {}
    .replace(/\\n/g, "\n")
    .trim();
  // split around markup: each text run between tags is a separate UI fragment
  // attribute values (title="…") are added on their own; tags split the text into UI fragments
  s = s.replace(/\s(?:title|placeholder|aria-label)="[^"]*"/g, "");
  for (let part of s.split(/<[^>]*>/)) {
    part = part.replace(/\s+/g, " ").trim();
    if (!CYR.test(part)) continue;
    if (!keys.has(part)) keys.set(part, where);
  }
}

import ts from "typescript";

/** Text of a template with ${…} replaced by {} (nested templates are visited on their own). */
function templateText(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  let out = node.head.text;
  for (const span of node.templateSpans) out += "{}" + span.literal.text;
  return out;
}

function scanTs(f, src) {
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    let text = null;
    if (ts.isStringLiteral(node)) text = node.text;
    else if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) text = templateText(node);
    if (text !== null && CYR.test(text)) {
      add(text, f);
      for (const a of text.matchAll(/(?:title|placeholder|aria-label)="([^"]*)"/g)) if (CYR.test(a[1])) add(a[1], f);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

for (const f of files) {
  const src = readFileSync(f, "utf8");
  if (f.endsWith(".rs")) {
    // skip comments, doc comments and tests
    const code = src.split("#[cfg(test)]")[0].replace(/^\s*\/\/.*$/gm, "").replace(/\/\/[^"\n]*$/gm, "");
    for (const m of code.matchAll(/"((?:[^"\\]|\\.)*)"/g)) if (CYR.test(m[1])) add(m[1], f);
    continue;
  }
  scanTs(f, src);
}

let en = {};
try { en = JSON.parse(readFileSync("locales/en.json", "utf8")); } catch { /* no dictionary yet */ }
const all = [...keys.keys()];
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(all, null, 1));
} else {
  const missing = all.filter((k) => !(k in en));
  console.log(`keys: ${all.length}, translated: ${all.length - missing.length}, missing: ${missing.length}`);
  for (const k of missing) console.log(`  ${keys.get(k)}: ${k}`);
}
