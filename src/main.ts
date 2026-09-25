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

type View = { id: string; icon: string; title: string; mount: (el: HTMLElement) => void; bottom?: boolean };

const views: View[] = [
  { id: "terminal", icon: "▶", title: "Терминал + AI", mount: mountTerminal },
  { id: "k8s", icon: "☸", title: "Kubernetes", mount: mountK8s },
  { id: "web", icon: "◎", title: "Grafana · ArgoCD · GitLab", mount: mountConnectors },
  { id: "net", icon: "⇄", title: "Сеть и DNS", mount: mountNetwork },
  { id: "notes", icon: "✎", title: "Obsidian", mount: mountNotes },
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
window.addEventListener("send-to-ai", () => show("terminal"));

show("terminal");
