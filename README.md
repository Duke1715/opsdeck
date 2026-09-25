# OpsDeck

Единая DevOps-панель: терминал с AI рядом, Kubernetes, веб-панели (Grafana / ArgoCD / GitLab), сеть и DNS, Obsidian, KeePass, Winbox.

Стек: **Tauri 2** (бэкенд на Rust) + TypeScript/Vite + xterm.js.

## Запуск (Ubuntu)

Один раз поставить системные зависимости Tauri:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev build-essential
```

Разработка:

```bash
npm install
npm run tauri dev
```

Сборка пакетов (.deb / AppImage): `npm run tauri build`.

## Что есть (фаза 1)

| Модуль | Как устроено |
|---|---|
| Терминал | PTY на `portable-pty`, вкладки, xterm.js. `Ctrl+Shift+T` новая вкладка, `Ctrl+Shift+W` закрыть |
| AI-панель | Справа от терминала: Claude Code / Codex / Gemini / Aider в своём PTY. `Ctrl+Shift+I` показать, `Ctrl+Shift+A` отправить выделение из терминала в AI |
| Grafana / ArgoCD / GitLab | Отдельное окно webview, автологин init-скриптом только на указанном origin. Секреты в системном keyring (Secret Service), метаданные в `~/.config/opsdeck/connectors.json` |
| Сеть и DNS | ping, mtr, traceroute, dig, nslookup, проверка TCP-порта. Системные бинарники без shell, вывод стримится |

Автологин:
- **Grafana**: `POST /login` из контекста страницы, cookie сессии остаётся в окне.
- **ArgoCD**: `POST /api/v1/session` или API-токен в cookie `argocd.token`.
- **GitLab**: заполняет форму `/users/sign_in`, 2FA вводится руками.
- Если логин не прошёл, повтор не чаще раза в минуту, чтобы не заблокировать учётку.

## Дорожная карта

**Фаза 2 — Kubernetes (аналог Lens)**
- kubeconfig-менеджер: drag&drop / импорт файлов, merge, переключение контекстов (`kube-rs`)
- Дерево: namespaces → workloads / pods / services / ingresses / configmaps / secrets
- Логи подов (стрим), `exec` в поде во вкладке терминала, port-forward, scale / restart / delete, YAML-редактор
- Watch-события, статусы в реальном времени

**Фаза 3 — хранилища и инструменты**
- KeePass: чтение `.kdbx` (крейт `keepass`), мастер-пароль только в памяти; источник кредов для коннекторов, Winbox, SSH
- Obsidian: путь к vault, поиск по заметкам, просмотр/редактирование markdown, открытие через `obsidian://open`
- Winbox: список MikroTik, запуск `winbox <host> <user> <pass>` с кредами из KeePass, SSH во вкладку

**Фаза 4 — «как Warp»**
- Shell integration (OSC 133): вывод по блокам команд, копирование и свёртка блока, «объясни ошибку» → AI
- Палитра команд (`Ctrl+K`), сохранённые сниппеты / workflows, история по проектам
- Сплиты терминала, профили SSH-хостов
- Claude Code IDE-интеграция: MCP-сервер через WebSocket и lock-файл в `~/.claude/ide/`, чтобы claude видел открытые файлы и выделение
- Встраивание веб-панелей во вкладки главного окна (multiwebview) вместо отдельных окон

## Ограничения

- Самоподписанные TLS-сертификаты webkit2gtk по умолчанию не принимает. Добавьте CA в систему (`/usr/local/share/ca-certificates` + `update-ca-certificates`).
- SSO/OAuth-вход (Keycloak, Google и т.п.) автоматом не проходит, но после ручного входа сессия в окне сохраняется.
