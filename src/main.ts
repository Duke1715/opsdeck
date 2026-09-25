import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { mountTerminal } from "./modules/terminal";
import { mountNetwork } from "./modules/network";
import { mountConnectors } from "./modules/connectors";
import { mountPlaceholder } from "./modules/placeholder";
import { mountK8s } from "./modules/k8s";

type View = { id: string; icon: string; title: string; mount: (el: HTMLElement) => void; onShow?: () => void };

const views: View[] = [
  { id: "terminal", icon: "▶", title: "Терминал + AI", mount: mountTerminal },
  { id: "k8s", icon: "☸", title: "Kubernetes", mount: mountK8s },
  { id: "web", icon: "◎", title: "Grafana · ArgoCD · GitLab", mount: mountConnectors },
  { id: "net", icon: "⇄", title: "Сеть и DNS", mount: mountNetwork },
  { id: "notes", icon: "✎", title: "Obsidian", mount: (el) => mountPlaceholder(el, "Obsidian", "Фаза 3: подключение vault, поиск и редактирование заметок, открытие в Obsidian через obsidian://.") },
  { id: "vault", icon: "🔑", title: "KeePass", mount: (el) => mountPlaceholder(el, "KeePass", "Фаза 3: чтение .kdbx, выдача кредов коннекторам, Winbox и SSH.") },
  { id: "winbox", icon: "⌘", title: "MikroTik / Winbox", mount: (el) => mountPlaceholder(el, "Winbox", "Фаза 3: список роутеров, запуск winbox с кредами из KeePass, SSH в терминал.") },
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
window.addEventListener("send-to-ai", () => show("terminal"));

show("terminal");
