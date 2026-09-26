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

## Что есть

| Модуль | Как устроено |
|---|---|
| Терминал | PTY на `portable-pty`, вкладки и сплиты (`Ctrl+Shift+D` вправо, `Ctrl+Shift+E` вниз, `Ctrl+Shift+←/→` между панелями), `Ctrl+Shift+C/V`. Shell integration (OSC 133, bash/zsh): блоки команд с кодом и временем, панель над блоком (копировать команду/вывод, ★ в сниппеты, ⇢ AI), плашка при ошибке «спросить AI», `Ctrl+Shift+↑/↓` по командам, новая вкладка открывается в текущей папке |
| Палитра | `Ctrl+Shift+P`: разделы, контексты k8s, веб-панели, MikroTik, заметки, пароли KeePass, история команд, сниппеты с параметрами `{{имя}}` |
| Claude Code IDE | OpsDeck — «IDE» для `claude`: lock-файл в `~/.claude/ide/`, MCP по WebSocket (токен, только 127.0.0.1). `claude`, запущенный в OpsDeck, подключается сам: видит выделение в заметках, «@ Claude» вставляет ссылку на заметку, может открыть заметку |
| AI-панель | Справа от терминала: Claude Code / Codex / Gemini / Aider в своём PTY. `Ctrl+Shift+I` показать, `Ctrl+Shift+A` отправить выделение из терминала в AI |
| Grafana / ArgoCD / GitLab | Отдельное окно webview, автологин init-скриптом только на указанном origin. Секреты в системном keyring (Secret Service), метаданные в `~/.config/opsdeck/connectors.json` |
| Kubernetes | kube-rs. Своё хранилище kubeconfig `~/.config/opsdeck/kubeconfigs` (по файлу на контекст, права 600): ＋ → «Добавить из ~/.kube/config» копирует выбранные контексты, также вставка YAML и drag&drop. Общий `~/.kube/config` не читается и не меняется (включается в ⚙). Вкладки терминала OpsDeck получают `KUBECONFIG` только на хранилище OpsDeck. Таблицы ресурсов с автообновлением, YAML (server-side apply), логи, scale / restart / delete, shell / exec / port-forward. Контекст можно скрыть 🙈, сделать «только чтение» 🔒 (блокирует бэкенд) или удалить 🗑 (с резервной копией) |
| KeePass | Чтение `.kdbx` (KDBX3/4, пароль и/или ключевой файл), только чтение. База расшифрована лишь в памяти, автоблокировка по таймауту. Копирование логина/пароля, пароль стирается из буфера через 30 с. Записи KeePass служат источником кредов для веб-панелей и MikroTik |
| Заметки | Дерево папок и поиск по vault (Obsidian или любая папка с .md), редактор и просмотр markdown (с `[[wikilinks]]`, HTML санитизируется), daily note по настройкам плагина, открытие в Obsidian через `obsidian://`. Все пути ограничены vault |
| MikroTik | Список устройств по группам: WinBox с логином и паролем из KeePass/keyring, SSH во вкладку терминала (пароль в буфер), ping |
| Настройки | ⚙ внизу слева: пути к .kdbx, vault, WinBox (подставляются автоматически, если найдены в домашней папке) |
| Сеть и DNS | ping, mtr, traceroute, dig, nslookup, проверка TCP-порта. Системные бинарники без shell, вывод стримится |

Автологин:
- **Grafana**: `POST /login` из контекста страницы, cookie сессии остаётся в окне.
- **ArgoCD**: `POST /api/v1/session` или API-токен в cookie `argocd.token`.
- **GitLab**: заполняет форму `/users/sign_in`, 2FA вводится руками.
- Если логин не прошёл, повтор не чаще раза в минуту, чтобы не заблокировать учётку.

## Дорожная карта

**Kubernetes, дальше**
- Watch вместо опроса раз в 5 с, метрики (metrics-server), CRD (Argo Applications, cert-manager), Helm-релизы
- Вкладка «Детали» (контейнеры, условия, события объекта), логи сразу со всех подов деплоймента

**Хранилища, дальше**
- KeePass: TOTP, запись в базу (сейчас только чтение, правки — в KeePassXC)
- MikroTik: импорт устройств из mikrotik-gitops / neighbours, бэкап конфига в git
- Obsidian: «сохранить выделение из терминала в заметку»

**Терминал, дальше**
- Встраивание веб-панелей во вкладки главного окна (multiwebview) вместо отдельных окон
- Профили SSH-хостов, AI-подсказка команды по описанию прямо в строке ввода

## Ограничения

- Самоподписанные TLS-сертификаты webkit2gtk по умолчанию не принимает. Добавьте CA в систему (`/usr/local/share/ca-certificates` + `update-ca-certificates`).
- WinBox получает пароль аргументом командной строки (иначе он не умеет), поэтому пароль виден в списке процессов вашего пользователя, пока WinBox запущен.
- SSO/OAuth-вход (Keycloak, Google и т.п.) автоматом не проходит, но после ручного входа сессия в окне сохраняется.
