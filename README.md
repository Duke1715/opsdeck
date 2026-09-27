# OpsDeck

**Единая рабочая панель DevOps-инженера**: терминал с AI рядом, Kubernetes, Grafana/ArgoCD/GitLab во вкладках, алерты, KeePass, SSH, MikroTik и заметки — в одном нативном приложении для Linux, Windows и macOS.

> *English:* OpsDeck is an open-source desktop cockpit for DevOps engineers — a Warp-style terminal with an AI side panel (Claude Code, Codex, Gemini, Aider), a Lens-like Kubernetes view, embedded Grafana/ArgoCD/GitLab tabs with auto-login, an alert inbox (Grafana, Prometheus Alertmanager, your own AI analyzers), KeePass, SSH/MikroTik launchers and a Markdown notes vault. Built with Rust + Tauri 2. MIT licensed.

Стек: **Rust + [Tauri 2](https://tauri.app)** (бэкенд), TypeScript + Vite (интерфейс), [xterm.js](https://xtermjs.org) (терминал), [kube-rs](https://kube.rs) (Kubernetes).

---

## Возможности

### Терминал «как Warp» + AI рядом
- Вкладки и сплиты, настоящий shell (bash/zsh/PowerShell).
- **Блоки команд**: у каждой команды — код выхода и время, панель действий (скопировать команду/вывод, сохранить как сниппет, отправить в AI), плашка «спросить AI» при ошибке, навигация по командам.
- **AI-панель** справа: Claude Code, Codex, Gemini или Aider в своём терминале; выделенный текст или вывод команды отправляется туда одной клавишей.
- **Интеграция с Claude Code как IDE**: `claude`, запущенный в OpsDeck, подключается к нему сам (MCP по WebSocket на 127.0.0.1) — видит выделение в заметках и получает ссылки на них.
- **Палитра команд** `Ctrl+Shift+P`: разделы, кластеры, хосты, заметки, пароли, история команд, сниппеты с параметрами `{{имя}}`.

### Kubernetes (в духе Lens)
- Собственное хранилище kubeconfig (ваш `~/.kube/config` не меняется): импорт выбранных контекстов, вставка YAML, drag & drop файлов.
- Живые таблицы (watch), CPU/RAM из metrics-server, любые CRD с колонками как у `kubectl get`.
- Логи пода и **сразу всех подов** Deployment/StatefulSet/DaemonSet/Job с фильтрами; вкладка «Детали» со ссылками на связанные объекты; YAML с server-side apply.
- Shell, port-forward, scale, restart, delete; Helm-релизы (values, история, rollback) и Argo CD Applications (sync/refresh).
- Режим **«только чтение»** для продовых контекстов — изменения блокирует бэкенд.

### Веб-панели и алерты
- Grafana, ArgoCD, GitLab и любые сайты — **вкладками внутри окна** с автоматическим входом (пароль из keyring или KeePass).
- **Алерты** 🔔: OpsDeck сам опрашивает Grafana Alerting, Prometheus Alertmanager и JSON-ленты ваших AI-анализаторов — на машину ничего не нужно пробрасывать. Уведомления на рабочем столе, история, ссылки на панели/silence, разбор алерта в AI.
- **Свой AI-анализатор** логов и алертов может присылать находки на `127.0.0.1` по токену — в приложении есть готовая инструкция и пример `curl`.

### Остальное
- **KeePass** (.kdbx): только чтение, база лишь в памяти, автоблокировка; пароли копируются с автоочисткой буфера и служат источником для всех разделов.
- **SSH**: профили (ключ, jump-хост, пароль из KeePass) и хосты из `~/.ssh/config`.
- **MikroTik**: WinBox и SSH в один клик.
- **Заметки**: дерево папок, поиск, редактор Markdown (работает с Obsidian vault).
- **Сеть и DNS**: ping, mtr, traceroute, dig, nslookup, проверка TCP-порта.

В каждом разделе есть кнопка **!** — встроенная подсказка: как работает, что где нажимать, горячие клавиши.

---

## Установка

### Готовые сборки
Установщики для Linux (`.deb`, `.rpm`, `.AppImage`), Windows (`.msi`, `.exe`) и macOS (`.dmg`) публикуются в **Releases** и собираются GitHub Actions на каждый тег `v*` (см. [Сборка в CI](#сборка-в-ci)).

> macOS-сборки пока не подписаны: при первом запуске откройте приложение через правый клик → «Открыть» или выполните `xattr -dr com.apple.quarantine /Applications/OpsDeck.app`.

### Сборка из исходников
Нужны [Rust](https://rustup.rs) (stable) и Node.js 20+.

**Linux (Debian/Ubuntu)** — системные библиотеки:
```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev build-essential
```
**Windows** — WebView2 (есть в Windows 10/11) и Visual Studio Build Tools (C++). **macOS** — Xcode Command Line Tools.

```bash
npm install
npm run tauri dev      # режим разработки
npm run tauri build    # установщики → src-tauri/target/release/bundle/
```

Необязательные внешние программы: `kubectl`, `helm`, `ssh`, `mtr`/`traceroute`/`dig`, WinBox, KeePassXC, `claude`/`codex`/`gemini`/`aider` — OpsDeck использует их, если они установлены.

---

## Быстрый старт

1. **Kubernetes**: раздел ☸ → **＋** → отметьте нужные контексты из `~/.kube/config`. Для прода включите 🔒.
2. **Grafana и алерты**: раздел ◎ → **＋ Добавить** → тип Grafana, URL, авторизация «токен» (Service account с ролью Viewer) → **Сохранить и проверить**. Алерты появятся в 🔔.
3. **Терминал + AI**: `Ctrl+Shift+I` открывает AI-панель, `Ctrl+Shift+A` отправляет выделение, `Ctrl+Shift+P` — палитра.
4. **KeePass, заметки, WinBox**: пути подхватываются автоматически, проверить можно в ⚙.

---

## Сборка в CI

`.github/workflows/build.yml` собирает на **нативных раннерах** — каждая платформа на своей ОС и архитектуре:

| Раннер | Что получается |
|---|---|
| `ubuntu-22.04` (x64), `ubuntu-22.04-arm` (arm64) | `.deb`, `.rpm`, `.AppImage` |
| `windows-latest` (x64), `windows-11-arm` (arm64, preview) | `.msi`, установщик NSIS `.exe` |
| `macos-latest` (Apple Silicon), `macos-15-intel` (Intel) | `.dmg`, `.app` |

- Пуш в `main`/`master` и pull request: проверки (TypeScript, `npm audit`, `cargo audit`), затем сборка; установщики — в артефактах запуска (Actions → запуск → Artifacts).
- Тег `v*` (например `git tag v0.1.0 && git push --tags`): то же + **черновик релиза** со всеми установщиками.
- arm64-раннеры Linux бесплатны для публичных репозиториев; в приватном их может не быть на вашем тарифе — тогда уберите строку `linux-arm64` из `matrix`.
- Dependabot (`.github/dependabot.yml`) раз в неделю предлагает обновления зависимостей.

---

## Архитектура

```
src/                  интерфейс (TypeScript, без фреймворка)
  modules/            разделы: terminal, k8s, connectors (веб-панели), alerts, keepass, notes, ssh, …
src-tauri/src/        бэкенд на Rust
  pty.rs              терминалы (portable-pty) + интеграция shell (OSC 133)
  k8s.rs              Kubernetes (kube-rs): списки, watch, логи, Helm, CRD
  embed.rs            встраивание веб-панелей во вкладки
  alerts.rs           сбор алертов и находок AI
  ide.rs              мост для Claude Code (MCP по WebSocket, 127.0.0.1)
  keepass.rs, ssh.rs, mikrotik.rs, notes.rs, connectors.rs, tools.rs, store.rs, …
```

Данные пользователя: `~/.config/opsdeck/` (права 600/700), секреты — в системном хранилище (Secret Service / Keychain / Credential Manager).

---

## Безопасность

- Секреты — только в системном хранилище или KeePass; база KeePass расшифрована лишь в памяти; пароли в буфере стираются через 30 с.
- OpsDeck не слушает внешние интерфейсы: мост для Claude Code и приём находок AI — только `127.0.0.1`, по токену, с защитой от запросов из браузера и DNS rebinding.
- Встроенные веб-страницы не имеют доступа к API приложения; автологин работает только на адресе коннектора.
- Строгая CSP интерфейса, экранирование всех внешних данных, Markdown через DOMPurify.
- Внешние программы запускаются без shell, аргументы валидируются; при импорте kubeconfig с `exec` показываются запускаемые им команды.
- В CI — `npm audit` и `cargo audit` на каждую сборку, Dependabot для зависимостей.

Нашли уязвимость? См. [SECURITY.md](SECURITY.md).

---

## Известные ограничения

- Веб-панели — нативные webview поверх интерфейса: пока фокус внутри панели, горячие клавиши OpsDeck не срабатывают. Если встраивание ведёт себя странно, запустите с `OPSDECK_NO_EMBED=1` — панели будут открываться отдельными окнами.
- SSO-вход (Keycloak, Google) и 2FA в веб-панелях проходятся вручную один раз.
- Блоки команд работают в bash и zsh; в PowerShell терминал работает без блоков. На Windows обычно нет `mtr` и `dig`.
- WinBox принимает пароль только аргументом командной строки — пока он запущен, пароль виден в списке процессов вашего пользователя.

---

## Участие

Issues и pull requests приветствуются. Перед PR: `npx tsc` в корне и `cargo check` в `src-tauri` должны проходить без ошибок.

## Лицензия

[MIT](LICENSE) © 2026 alex
