import { PtyTerminal } from "./pty";

type Tab = { pty: PtyTerminal; btn: HTMLElement; host: HTMLElement };

const AI_PROVIDERS: Record<string, { program: string; args?: string[] }> = {
  "Claude Code": { program: "claude" },
  Codex: { program: "codex" },
  Gemini: { program: "gemini" },
  Aider: { program: "aider" },
};

function load(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function mountTerminal(root: HTMLElement) {
  root.classList.add("terminal-view");
  root.innerHTML = `
    <div class="term-main">
      <div class="tabbar">
        <div class="tabs"></div>
        <button class="icon" data-act="new" title="Новая вкладка (Ctrl+Shift+T)">＋</button>
        <span class="spacer"></span>
        <button class="ghost" data-act="send" title="Отправить выделение в AI (Ctrl+Shift+A)">⇢ в AI</button>
        <button class="ghost" data-act="ai" title="Показать/скрыть AI-панель (Ctrl+Shift+I)">AI ▸</button>
      </div>
      <div class="term-hosts"></div>
    </div>
    <div class="splitter" hidden></div>
    <aside class="ai-panel" hidden>
      <div class="tabbar">
        <select class="ai-provider"></select>
        <span class="spacer"></span>
        <button class="icon" data-act="ai-restart" title="Перезапустить">↻</button>
      </div>
      <div class="ai-host"></div>
    </aside>`;

  const tabsEl = root.querySelector<HTMLElement>(".tabs")!;
  const hostsEl = root.querySelector<HTMLElement>(".term-hosts")!;
  const aiPanel = root.querySelector<HTMLElement>(".ai-panel")!;
  const aiHost = root.querySelector<HTMLElement>(".ai-host")!;
  const splitter = root.querySelector<HTMLElement>(".splitter")!;
  const providerSel = root.querySelector<HTMLSelectElement>(".ai-provider")!;

  const tabs: Tab[] = [];
  let active: Tab | null = null;
  let ai: PtyTerminal | null = null;

  for (const name of Object.keys(AI_PROVIDERS)) providerSel.add(new Option(name, name));
  providerSel.value = load("opsdeck.ai.provider", "Claude Code");

  function activate(t: Tab) {
    active = t;
    for (const x of tabs) {
      x.host.hidden = x !== t;
      x.btn.classList.toggle("active", x === t);
    }
    requestAnimationFrame(() => { t.pty.resize(); t.pty.term.focus(); });
  }

  function close(t: Tab) {
    const i = tabs.indexOf(t);
    if (i < 0) return;
    tabs.splice(i, 1);
    t.pty.dispose();
    t.btn.remove();
    t.host.remove();
    if (tabs.length === 0) newTab();
    else if (active === t) activate(tabs[Math.max(0, i - 1)]);
  }

  function newTab() {
    const host = document.createElement("div");
    host.className = "term-host";
    hostsEl.appendChild(host);

    const btn = document.createElement("div");
    btn.className = "tab";
    btn.innerHTML = `<span class="label"></span><span class="x" title="Закрыть">×</span>`;
    tabsEl.appendChild(btn);

    const pty = new PtyTerminal(host);
    const t: Tab = { pty, btn, host };
    const label = btn.querySelector<HTMLElement>(".label")!;
    label.textContent = `shell ${tabs.length + 1}`;
    pty.term.onTitleChange((title) => (label.textContent = title || label.textContent));
    btn.onclick = () => activate(t);
    btn.querySelector<HTMLElement>(".x")!.onclick = (e) => { e.stopPropagation(); close(t); };
    pty.onExit = () => close(t);

    tabs.push(t);
    activate(t);
  }

  function startAi() {
    ai?.dispose();
    aiHost.innerHTML = "";
    const p = AI_PROVIDERS[providerSel.value];
    ai = new PtyTerminal(aiHost, { program: p.program, args: p.args });
  }

  function toggleAi(force?: boolean) {
    const show = force ?? aiPanel.hidden;
    aiPanel.hidden = !show;
    splitter.hidden = !show;
    if (show && !ai) startAi();
    requestAnimationFrame(() => {
      active?.pty.resize();
      ai?.resize();
      (show ? ai : active?.pty)?.term.focus();
    });
  }

  function sendSelection() {
    const sel = active?.pty.term.getSelection().trim();
    if (!sel) return;
    toggleAi(true);
    // bracketed paste so multi-line output lands as one message instead of being submitted line by line
    setTimeout(() => ai?.send(`\x1b[200~${sel}\x1b[201~`), ai ? 0 : 1500);
    ai?.term.focus();
  }

  // drag to resize the AI panel
  splitter.addEventListener("pointerdown", (e) => {
    splitter.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const w = Math.min(Math.max(root.getBoundingClientRect().right - ev.clientX, 280), root.clientWidth - 320);
      aiPanel.style.width = `${w}px`;
    };
    const up = () => {
      splitter.removeEventListener("pointermove", move);
      save("opsdeck.ai.width", aiPanel.style.width);
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up, { once: true });
  });
  aiPanel.style.width = load("opsdeck.ai.width", "520px");

  providerSel.onchange = () => { save("opsdeck.ai.provider", providerSel.value); startAi(); };
  root.querySelector<HTMLElement>("[data-act=new]")!.onclick = newTab;
  root.querySelector<HTMLElement>("[data-act=ai]")!.onclick = () => toggleAi();
  root.querySelector<HTMLElement>("[data-act=send]")!.onclick = sendSelection;
  root.querySelector<HTMLElement>("[data-act=ai-restart]")!.onclick = startAi;

  window.addEventListener("keydown", (e) => {
    if (root.hidden || !e.ctrlKey || !e.shiftKey) return;
    const k = e.key.toUpperCase();
    if (k === "T") newTab();
    else if (k === "W" && active) close(active);
    else if (k === "I") toggleAi();
    else if (k === "A") sendSelection();
    else return;
    e.preventDefault();
  }, true);

  window.addEventListener("view-shown", (e) => {
    if ((e as CustomEvent).detail !== "terminal") return;
    requestAnimationFrame(() => { active?.pty.resize(); ai?.resize(); active?.pty.term.focus(); });
  });

  newTab();
}
