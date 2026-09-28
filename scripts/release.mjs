#!/usr/bin/env node
// Выпуск новой версии: npm run release -- 0.2.0 "Что нового (станет описанием релиза и окна обновления)"
// Поднимает версию в package.json, tauri.conf.json, Cargo.toml и Cargo.lock, коммитит,
// ставит аннотированный тег v<версия> и пушит — GitHub Actions соберёт и опубликует релиз.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [version, ...notesParts] = process.argv.slice(2);
const notes = notesParts.join(" ").trim();
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error('Использование: npm run release -- 0.2.0 "что нового"');
  process.exit(1);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain")) {
  console.error("Есть незакоммиченные изменения — закоммитьте или уберите их перед релизом.");
  process.exit(1);
}
if (git("tag", "-l", `v${version}`)) {
  console.error(`Тег v${version} уже существует.`);
  process.exit(1);
}

const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, "utf8")));
edit("package.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("src-tauri/tauri.conf.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = "[^"]+"/m, `version = "${version}"`));
edit("src-tauri/Cargo.lock", (s) => s.replace(/(name = "opsdeck"\nversion = )"[^"]+"/, `$1"${version}"`));

git("add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock");
// the version may already be set (e.g. the very first release): commit only if something changed
if (git("status", "--porcelain")) git("commit", "-m", `Release v${version}`);
git("tag", "-a", `v${version}`, "-m", notes || `OpsDeck v${version}`);
git("push");
git("push", "origin", `v${version}`);
console.log(`✓ v${version} отправлена. Сборка и публикация релиза: GitHub → Actions.`);
