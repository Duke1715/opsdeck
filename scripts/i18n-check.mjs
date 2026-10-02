#!/usr/bin/env node
// Runs every Russian UI text through the English translator and reports broken results:
// words that mix Cyrillic and Latin letters (a pattern cut a word), and placeholder mismatches
// in the dictionary. Exit code 1 if anything is found.   node scripts/i18n-check.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "opsdeck-i18n-"));
const out = join(dir, "core.mjs");
await build({ entryPoints: ["src/i18n-core.ts"], bundle: true, format: "esm", outfile: out, logLevel: "silent" });
const { buildPatterns, makeTr } = await import(pathToFileURL(out).href);

const dict = JSON.parse(readFileSync("locales/en.json", "utf8"));
const tr = makeTr(dict, buildPatterns(dict));
const problems = [];

// 1. dictionary: placeholders must match
for (const [k, v] of Object.entries(dict)) {
  if ((k.match(/\{\}/g) ?? []).length !== (v.match(/\{\}/g) ?? []).length) problems.push(`placeholders differ: «${k}» → «${v}»`);
}

// 2. corpus: all UI keys (placeholders filled with sample values) + the Russian help text
const keys = JSON.parse(execFileSync("node", ["scripts/i18n-extract.mjs", "--json"], { encoding: "utf8", maxBuffer: 1 << 26 }));
const samples = ["12", "prod-api", "Задачи.md", "k3s-devcars", "1.2", "infra/dns", "0.4.2 от 03.10.2026"];
const corpus = new Set();
for (const k of keys) {
  corpus.add(k);
  for (const s of samples) corpus.add(k.replace(/\{\}/g, s));
}
const help = readFileSync("src/modules/help.ts", "utf8");
for (const m of help.matchAll(/>([^<>]*[А-Яа-яЁё][^<>]*)</g)) {
  const text = m[1].replace(/\$\{[^}]*\}/g, "Ctrl+K").replace(/\s+/g, " ").trim();
  if (text) corpus.add(text);
}

const ALLOWED = new Set(["ЮMoney"]);
const mixed = /(?=[\p{L}]*\p{Script=Cyrillic})(?=[\p{L}]*\p{Script=Latin})[\p{L}]+/gu;
for (const s of corpus) {
  const res = tr(s);
  // only what the translation introduced (the samples themselves can make mixed words)
  const before = new Set(s.match(mixed) ?? []);
  for (const w of res.match(mixed) ?? []) {
    if (!ALLOWED.has(w) && !before.has(w)) problems.push(`mixed word «${w}»: «${s}» → «${res}»`);
  }
  // a translated text must not keep half of a Russian word glued to English
  if (res !== s && /[a-z][А-Яа-яЁё]|[А-Яа-яЁё][a-z]/.test(res.replace(/ЮMoney/g, "")) && !/[a-z][А-Яа-яЁё]|[А-Яа-яЁё][a-z]/.test(s)) {
    problems.push(`glued: «${s}» → «${res}»`);
  }
}

if (problems.length) {
  console.log(problems.join("\n"));
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`ok: ${corpus.size} texts checked, dictionary ${Object.keys(dict).length} entries`);
