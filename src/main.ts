import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { mountTerminal } from "./modules/terminal";
import { mountNetwork } from "./modules/network";
import { mountConnectors } from "./modules/connectors";
import { mountK8s } from "./modules/k8s";
import { mountKeepass } from "./modules/keepass";
import { mountNotes } from "./modules/notes";
import { mountMikrotik } from "./modules/mikrotik";
import { mountSettings } from "./modules/settings";
import { mountSsh } from "./modules/ssh";
import { mountAlerts } from "./modules/alerts";
import { checkUpdates } from "./modules/updates";
import { logUi } from "./modules/ui";

// anything that blows up in the UI ends up in the log file (⚙ → Журнал)
window.addEventListener("error", (e) => logUi("error", `JS: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}${e.error?.stack ? "\n" + e.error.stack : ""}`));
window.addEventListener("unhandledrejection", (e) => logUi("error", `Promise: ${e.reason?.stack ?? e.reason}`));
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { registerProvider } from "./modules/palette";

type View = { id: string; icon: string; title: string; mount: (el: HTMLElement) => void; bottom?: boolean };

const views: View[] = [
  { id: "terminal", icon: "▶", title: "Терминал + AI", mount: mountTerminal },
  { id: "k8s", icon: "☸", title: "Kubernetes", mount: mountK8s },
  { id: "web", icon: "◎", title: "Grafana · ArgoCD · GitLab", mount: mountConnectors },
  { id: "alerts", icon: "🔔", title: "Алерты", mount: mountAlerts },
  { id: "net", icon: "⇄", title: "Сеть и DNS", mount: mountNetwork },
  { id: "ssh", icon: "🖧", title: "SSH", mount: mountSsh },
  { id: "notes", icon: "✎", title: "Заметки", mount: mountNotes },
  { id: "vault", icon: "🔑", title: "KeePass", mount: mountKeepass },
  { id: "winbox", icon: "⌘", title: "MikroTik / WinBox", mount: mountMikrotik },
  { id: "settings", icon: "⚙", title: "Настройки", mount: mountSettings, bottom: true },
];

const sidebar = document.getElementById("sidebar")!;
const container = document.getElementById("views")!;
const panes = new Map<string, HTMLElement>();

function show(id: string) {
  for (const [vid, el] of panes) el.hidden = vid !== id;
  sidebar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
  window.dispatchEvent(new CustomEvent("view-shown", { detail: id }));
}

for (const v of views) {
  const btn = document.createElement("button");
  btn.dataset.view = v.id;
  btn.title = v.title;
  btn.textContent = v.icon;
  btn.onclick = () => show(v.id);
  if (v.bottom) btn.classList.add("bottom");
  sidebar.appendChild(btn);

  const pane = document.createElement("section");
  pane.className = "view";
  pane.hidden = true;
  container.appendChild(pane);
  panes.set(v.id, pane);
  v.mount(pane);
}

// a module asked for a terminal tab: switch to the terminal view (the tab itself is created there)
window.addEventListener("open-terminal", () => show("terminal"));
window.addEventListener("show-view", (e) => show((e as CustomEvent<string>).detail));
// firing-alerts counter on the 🔔 button
const setAlertBadge = (n: number) => {
  const b = sidebar.querySelector<HTMLElement>("[data-view=alerts]");
  if (!b) return;
  b.dataset.badge = n > 99 ? "99+" : String(n);
  b.classList.toggle("has-badge", n > 0);
};
listen<number>("alerts-changed", (e) => setAlertBadge(e.payload));
invoke<{ firing: number }>("alerts_get", { historyLimit: 0 }).then((v) => setAlertBadge(v.firing)).catch(() => {});

// quiet update check a little after startup (if enabled in settings)
setTimeout(() => {
  invoke<{ update_auto_check: boolean }>("settings_get")
    .then((s) => { if (s.update_auto_check) checkUpdates(true); })
    .catch(() => {});
}, 8000);

registerProvider(() => views.map((v) => ({ group: "Перейти", title: v.title, hint: v.icon, run: () => show(v.id) })));
window.addEventListener("send-to-ai", () => show("terminal"));

show("terminal");
