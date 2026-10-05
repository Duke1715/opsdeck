import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { mountTerminal } from "./modules/terminal";
import { mountNetwork } from "./modules/network";
import { mountConnectors } from "./modules/connectors";
import { mountK8s } from "./modules/k8s";
import { mountKeepass } from "./modules/keepass";
import { mountNotes } from "./modules/notes";
import { mountDb } from "./modules/db";
import { mountCode } from "./modules/code";
import { mountTasks } from "./modules/tasks";
import { mountMikrotik } from "./modules/mikrotik";
import { mountSettings } from "./modules/settings";
import { mountSsh } from "./modules/ssh";
import { mountAlerts } from "./modules/alerts";
import { checkUpdates } from "./modules/updates";
import { logUi } from "./modules/ui";
import { currentLang, startI18n } from "./i18n";

// anything that blows up in the UI ends up in the log file (⚙ → Журнал)
window.addEventListener("error", (e) => logUi("error", `JS: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}${e.error?.stack ? "\n" + e.error.stack : ""}`));
window.addEventListener("unhandledrejection", (e) => logUi("error", `Promise: ${e.reason?.stack ?? e.reason}`));
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { registerProvider } from "./modules/palette";

import { icon } from "./modules/icons";

type View = { id: string; svg: string; title: string; mount: (el: HTMLElement) => void; bottom?: boolean };

const views: View[] = [
  { id: "terminal", svg: icon("terminal", 20), title: "Терминал + AI", mount: mountTerminal },
  { id: "k8s", svg: icon("k8s", 20), title: "Kubernetes", mount: mountK8s },
  { id: "web", svg: icon("web", 20), title: "Grafana · ArgoCD · GitLab", mount: mountConnectors },
  { id: "alerts", svg: icon("bell", 20), title: "Алерты", mount: mountAlerts },
  { id: "net", svg: icon("net", 20), title: "Сеть и DNS", mount: mountNetwork },
  { id: "ssh", svg: icon("server", 20), title: "SSH", mount: mountSsh },
  { id: "code", svg: icon("code", 20), title: "IDE: код и git", mount: mountCode },
  { id: "db", svg: icon("db", 20), title: "Базы данных", mount: mountDb },
  { id: "notes", svg: icon("notes", 20), title: "Заметки", mount: mountNotes },
  { id: "tasks", svg: icon("tasks", 20), title: "Задачи и напоминания", mount: mountTasks },
  { id: "vault", svg: icon("key", 20), title: "KeePass", mount: mountKeepass },
  { id: "winbox", svg: icon("router", 20), title: "MikroTik / WinBox", mount: mountMikrotik },
  { id: "settings", svg: icon("settings", 20), title: "Настройки", mount: mountSettings, bottom: true },
];

startI18n();
// the backend translates its own notifications (reminders, alerts) the same way
invoke("set_lang", { lang: currentLang() }).catch(() => {});

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
  btn.innerHTML = v.svg;
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

// ----- user order of the sidebar icons: drag with the mouse, kept in localStorage -----
const ORDER_KEY = "opsdeck.sidebar.order";
const movable = () => [...sidebar.querySelectorAll<HTMLButtonElement>("button[data-view]:not(.bottom)")];
const bottomBtn = sidebar.querySelector("button.bottom");
try {
  const saved: string[] = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]");
  const byId = new Map(movable().map((b) => [b.dataset.view!, b]));
  // saved ones first in their order; views added in later versions keep their default place after them
  for (const id of saved) { const b = byId.get(id); if (b) sidebar.insertBefore(b, bottomBtn); }
  for (const b of movable()) if (!saved.includes(b.dataset.view!)) sidebar.insertBefore(b, bottomBtn);
} catch { /* broken value: default order */ }

// pointer-based (HTML5 drag-and-drop is unreliable inside the Tauri webview)
let dragJustEnded = false;
sidebar.addEventListener("pointerdown", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-view]:not(.bottom)");
  if (!btn || e.button !== 0) return;
  const startY = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.abs(ev.clientY - startY) < 6) return;
      dragging = true;
      btn.setPointerCapture(ev.pointerId);
      btn.classList.add("dragging");
    }
    const others = movable().filter((b) => b !== btn);
    const before = others.find((b) => { const r = b.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    sidebar.insertBefore(btn, before ?? bottomBtn);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!dragging) return;
    btn.classList.remove("dragging");
    dragJustEnded = true;
    setTimeout(() => { dragJustEnded = false; }, 0);
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(movable().map((b) => b.dataset.view))); } catch { /* ignore */ }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});
// the click that ends a drag must not switch the view
sidebar.addEventListener("click", (e) => { if (dragJustEnded) { e.stopPropagation(); e.preventDefault(); } }, true);

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

registerProvider(() => views.map((v) => ({ group: "Перейти", title: v.title, hint: v.id, run: () => show(v.id) })));
window.addEventListener("send-to-ai", () => show("terminal"));

show("terminal");
