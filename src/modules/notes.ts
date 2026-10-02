import { helpBtn } from "./help";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { listen } from "@tauri-apps/api/event";
import { ask, esc, toast } from "./ui";
import { registerProvider } from "./palette";

type Note = { path: string; mtime: number };
type Vault = { root: string; name: string; notes: Note[]; folders?: string[] };
type Hit = { path: string; line: number; text: string };

/** [[Note]] / [[Note|alias]] → links handled by the click handler below. */
function wikilinks(md: string): string {
  return md.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(\|([^\]]+))?\]\]/g, (_m, target: string, _h, _a, alias?: string) =>
    `[${alias ?? target}](#note:${encodeURIComponent(target.trim())})`);
}

export function mountNotes(root: HTMLElement) {
  root.classList.add("notes");
  root.innerHTML = `
    <aside class="notes-side">
      <div class="side-head"><span class="vault-name">Заметки</span>
        <span class="row">
          <button class="icon" data-a="daily" title="Заметка на сегодня">📅</button>
          <button class="icon" data-a="new" title="Новая заметка">＋</button>
          <button class="icon" data-a="collapse" title="Свернуть все папки">⊟</button>
          <button class="icon" data-a="reload" title="Обновить">↻</button>
        </span></div>
      <input class="notes-q" placeholder="поиск по заметкам…" spellcheck="false" />
      <div class="notes-list"></div>
    </aside>
    <div class="notes-main">
      <div class="notes-bar">
        <strong class="note-path muted">выберите заметку</strong><span class="dirty" hidden>●</span>
        <span class="spacer"></span>
        <div class="seg"><button data-m="edit">Редактор</button><button data-m="view">Просмотр</button></div>
        <button class="ghost" data-a="mention" disabled title="Вставить ссылку на заметку (или выделенные строки) в запрос Claude Code">@ Claude</button>
        <button data-a="save" title="Ctrl+S" disabled>Сохранить</button>
        ${helpBtn("notes")}
        <button class="ghost" data-a="obsidian" disabled title="Открыть эту заметку в приложении Obsidian">Obsidian ↗</button>
      </div>
      <textarea class="note-editor" spellcheck="false" hidden></textarea>
      <article class="note-view md" hidden></article>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const listEl = $(".notes-list"), q = $<HTMLInputElement>(".notes-q"), editor = $<HTMLTextAreaElement>(".note-editor");
  const view = $(".note-view"), dirtyEl = $(".dirty"), saveBtn = $<HTMLButtonElement>("[data-a=save]");
  let vault: Vault | null = null;
  let current: string | null = null;
  let saved = "";
  let mode: "edit" | "view" = (localStorage.getItem("opsdeck.notes.mode") as "edit" | "view") ?? "view";

  const dirty = () => current !== null && editor.value !== saved;
  const markDirty = () => { dirtyEl.hidden = !dirty(); saveBtn.disabled = !dirty(); };

  async function loadVault() {
    try {
      vault = await invoke<Vault>("notes_list");
      $(".vault-name").textContent = vault.name;
      $(".vault-name").title = vault.root;
      drawList();
    } catch (e) {
      vault = null;
      listEl.innerHTML = `<p class="muted pad">${esc(e)}</p>`;
    }
  }

  type Folder = { name: string; path: string; folders: Map<string, Folder>; notes: Note[]; count: number };

  function buildTree(notes: Note[], dirs: string[] = []): Folder {
    const root: Folder = { name: "", path: "", folders: new Map(), notes: [], count: 0 };
    // empty folders too, so a note can be created in / dragged to them
    for (const d of dirs) {
      let f = root;
      for (const part of d.split("/")) {
        const path = f.path ? `${f.path}/${part}` : part;
        if (!f.folders.has(part)) f.folders.set(part, { name: part, path, folders: new Map(), notes: [], count: 0 });
        f = f.folders.get(part)!;
      }
    }
    for (const n of notes) {
      const parts = n.path.split("/");
      let f = root;
      f.count++;
      for (const part of parts.slice(0, -1)) {
        const path = f.path ? `${f.path}/${part}` : part;
        if (!f.folders.has(part)) f.folders.set(part, { name: part, path, folders: new Map(), notes: [], count: 0 });
        f = f.folders.get(part)!;
        f.count++;
      }
      f.notes.push(n);
    }
    return root;
  }

  const openDirs = new Set<string>(JSON.parse(localStorage.getItem("opsdeck.notes.open") ?? "[]") as string[]);
  const saveOpen = () => localStorage.setItem("opsdeck.notes.open", JSON.stringify([...openDirs]));
  const title = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");
  const noteBtn = (n: Note, depth: number, label = title(n.path)) =>
    `<button class="note-item ${n.path === current ? "active" : ""}" style="--depth:${depth}" data-p="${esc(n.path)}" title="${esc(n.path)}">
      <span class="tree-icon">📄</span><span class="tree-label">${esc(label)}</span></button>`;

  function renderFolder(f: Folder, depth: number): string {
    const folders = [...f.folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const notes = [...f.notes].sort((a, b) => title(a.path).localeCompare(title(b.path), undefined, { numeric: true }));
    return folders.map((d) => `
      <div class="tree-dir ${openDirs.has(d.path) ? "open" : ""}" data-dir="${esc(d.path)}">
        <button class="tree-row" style="--depth:${depth}"><span class="tree-caret">▸</span><span class="tree-icon">📁</span>
          <span class="tree-label">${esc(d.name)}</span><span class="tree-count">${d.count}</span>
          <span class="tree-add" data-add="${esc(d.path)}" title="Новая заметка в этой папке">＋</span></button>
        <div class="tree-children" style="--guide:${depth}">${openDirs.has(d.path) ? renderFolder(d, depth + 1) : ""}</div>
      </div>`).join("") + notes.map((n) => noteBtn(n, depth)).join("");
  }

  let tree: Folder | null = null;

  function drawList() {
    if (!vault) return;
    if (q.value.trim().length >= 2) return search();
    tree = buildTree(vault.notes, vault.folders);
    const recent = [...vault.notes].sort((a, b) => b.mtime - a.mtime).slice(0, 6);
    const recentOpen = localStorage.getItem("opsdeck.notes.recent") !== "0";
    listEl.innerHTML = `
      <div class="tree-dir tree-section ${recentOpen ? "open" : ""}" data-section="recent">
        <button class="tree-row" style="--depth:0"><span class="tree-caret">▸</span><span class="tree-label">Недавние</span></button>
        <div class="tree-children">${recent.map((n) => noteBtn(n, 1)).join("")}</div>
      </div>
      <div class="tree-sep"></div>
      ${renderFolder(tree, 0)}`;
  }

  /** Expands the folders on the way to `path` so the active note is visible in the tree. */
  function reveal(path: string) {
    const parts = path.split("/").slice(0, -1);
    parts.forEach((_, i) => openDirs.add(parts.slice(0, i + 1).join("/")));
    saveOpen();
  }

  function findFolder(path: string): Folder | null {
    let f = tree;
    for (const part of path.split("/")) f = f?.folders.get(part) ?? null;
    return f;
  }

  let lastFolder = "";
  listEl.addEventListener("click", (e) => {
    const add = (e.target as HTMLElement).closest<HTMLElement>(".tree-add");
    if (add) { e.stopPropagation(); newNote(add.dataset.add!); return; }
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (!row) return;
    const dir = row.parentElement!;
    if (dir.dataset.dir !== undefined) lastFolder = dir.dataset.dir;
    if (dir.dataset.section === "recent") {
      dir.classList.toggle("open");
      localStorage.setItem("opsdeck.notes.recent", dir.classList.contains("open") ? "1" : "0");
      return;
    }
    const path = dir.dataset.dir!;
    const children = dir.querySelector<HTMLElement>(":scope > .tree-children")!;
    if (dir.classList.toggle("open")) {
      openDirs.add(path);
      const f = findFolder(path);
      const depth = path.split("/").length;
      if (f && !children.innerHTML.trim()) children.innerHTML = renderFolder(f, depth);
    } else {
      openDirs.delete(path);
    }
    saveOpen();
  });

  async function search() {
    const hits = await invoke<Hit[]>("note_search", { query: q.value }).catch(() => [] as Hit[]);
    listEl.innerHTML = hits.length ? hits.map((h) => `
      <button class="note-item hit" data-p="${esc(h.path)}">
        <span>${esc(h.path.replace(/\.md$/, ""))}${h.line ? `<span class="muted">:${h.line}</span>` : ""}</span>
        ${h.text ? `<span class="muted hit-text">${esc(h.text)}</span>` : ""}</button>`).join("") : `<p class="muted pad">Ничего не найдено</p>`;
  }

  async function openNote(path: string) {
    if (dirty() && (await ask("Несохранённые изменения", `Изменения в «${current}» будут потеряны. Продолжить?`, { ok: "Не сохранять", danger: true })) === null) return;
    try {
      const text = await invoke<string>("note_read", { path });
      current = path;
      saved = text;
      if (!q.value.trim()) { reveal(path); drawList(); }
      editor.value = text;
      $(".note-path").textContent = path.replace(/\.md$/, "");
      $(".note-path").classList.remove("muted");
      $<HTMLButtonElement>("[data-a=obsidian]").disabled = false;
      $<HTMLButtonElement>("[data-a=mention]").disabled = false;
      const fp = fullPath(path);
      invoke("ide_editor", { editor: { uri: `file://${fp}`, filePath: fp, label: title(path), isActive: true, isDirty: false, languageId: "markdown" } }).catch(() => {});
      markDirty();
      setMode(mode);
      listEl.querySelectorAll<HTMLElement>(".note-item").forEach((b) => b.classList.toggle("active", b.dataset.p === path));
    } catch (e) { toast(String(e), "err"); }
  }

  function render() {
    view.innerHTML = DOMPurify.sanitize(marked.parse(wikilinks(editor.value), { async: false }) as string);
  }

  function setMode(m: "edit" | "view") {
    mode = m;
    localStorage.setItem("opsdeck.notes.mode", m);
    root.querySelectorAll<HTMLElement>("[data-m]").forEach((b) => b.classList.toggle("active", b.dataset.m === m));
    if (current === null) return;
    editor.hidden = m !== "edit";
    view.hidden = m !== "view";
    if (m === "view") render(); else editor.focus();
  }

  async function save() {
    if (!current || !dirty()) return;
    try {
      await invoke("note_write", { path: current, content: editor.value });
      saved = editor.value;
      markDirty();
      toast("Сохранено");
    } catch (e) { toast(String(e), "err"); }
  }

  listEl.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".note-item");
    if (b) openNote(b.dataset.p!);
  };
  view.onclick = (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#note:") && vault) {
      const target = decodeURIComponent(href.slice(6)).toLowerCase();
      const hit = vault.notes.find((n) => n.path.toLowerCase().replace(/\.md$/, "") === target)
        ?? vault.notes.find((n) => n.path.split("/").pop()!.toLowerCase().replace(/\.md$/, "") === target.split("/").pop());
      hit ? openNote(hit.path) : toast(`Заметка «${target}» не найдена`, "err");
    }
  };
  editor.addEventListener("input", markDirty);
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end"); markDirty(); }
  });
  root.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    if (e.ctrlKey && e.key.toLowerCase() === "e" && current) { e.preventDefault(); setMode(mode === "edit" ? "view" : "edit"); }
  });
  root.querySelectorAll<HTMLElement>("[data-m]").forEach((b) => (b.onclick = () => setMode(b.dataset.m as "edit" | "view")));
  saveBtn.onclick = save;
  $("[data-a=obsidian]").onclick = () => current && invoke("note_open_obsidian", { path: current }).catch((e) => toast(String(e), "err"));
  $("[data-a=reload]").onclick = loadVault;

  // ----- Claude Code IDE bridge -----
  const fullPath = (rel: string) => `${vault?.root ?? ""}/${rel}`;
  const lineCol = (text: string, offset: number) => {
    const before = text.slice(0, offset);
    const line = before.split("\n").length - 1;
    return { line, character: offset - (before.lastIndexOf("\n") + 1) };
  };
  let selTimer = 0;
  document.addEventListener("selectionchange", () => {
    if (document.activeElement !== editor || !current) return;
    clearTimeout(selTimer);
    selTimer = window.setTimeout(() => {
      const { selectionStart: a, selectionEnd: b, value } = editor;
      const fp = fullPath(current!);
      invoke("ide_selection", { selection: {
        text: value.slice(a, b), filePath: fp, fileUrl: `file://${fp}`,
        selection: { start: lineCol(value, a), end: lineCol(value, b), isEmpty: a === b },
      } }).catch(() => {});
    }, 250);
  });
  $("[data-a=mention]").onclick = () => {
    if (!current) return;
    const { selectionStart: a, selectionEnd: b, value } = editor;
    const lines = !editor.hidden && a !== b ? { lineStart: lineCol(value, a).line, lineEnd: lineCol(value, b).line } : { lineStart: null, lineEnd: null };
    invoke("ide_at_mention", { filePath: fullPath(current), ...lines })
      .then(() => toast("Ссылка на заметку вставлена в запрос Claude"), (e) => toast(String(e), "err"));
  };
  // Claude asked OpsDeck to open a file (openFile tool)
  listen<string>("ide-open-file", (e) => {
    const root = vault?.root;
    if (root && e.payload.startsWith(root + "/") && e.payload.endsWith(".md")) {
      window.dispatchEvent(new CustomEvent("show-view", { detail: "notes" }));
      openNote(e.payload.slice(root.length + 1));
    } else {
      toast(`Claude открыл ${e.payload} — OpsDeck показывает только заметки`, "err");
    }
  });
  registerProvider(() => (vault?.notes ?? []).map((n) => ({
    group: "Заметка", title: n.path.replace(/\.md$/, ""),
    run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "notes" })); openNote(n.path); },
  })));
  $("[data-a=collapse]").onclick = () => { openDirs.clear(); saveOpen(); drawList(); };
  $("[data-a=daily]").onclick = async () => {
    try { const p = await invoke<string>("note_daily"); await loadVault(); openNote(p); } catch (e) { toast(String(e), "err"); }
  };
  /** folder "" = vault root; the name may still contain subfolders ("a/b/note"). */
  async function newNote(folder: string | null) {
    const name = folder === null
      ? await ask("Новая заметка", "Путь внутри vault (папки через /):", { input: lastFolder ? `${lastFolder}/` : "Inbox/", ok: "Создать" })
      : await ask("Новая заметка", `Имя заметки в папке «${folder || vault?.name || "/"}»:`, { input: "", ok: "Создать" });
    const clean = name?.trim().replace(/^\/+/, "");
    if (!clean || clean.endsWith("/")) return;
    const rel = folder ? `${folder}/${clean}` : clean;
    const path = rel.endsWith(".md") ? rel : `${rel}.md`;
    if (vault?.notes.some((n) => n.path === path)) { toast(`«${path}» уже есть — открываю её`); openNote(path); return; }
    try {
      await invoke("note_write", { path, content: `# ${path.split("/").pop()!.replace(/\.md$/, "")}\n\n` });
      await loadVault();
      mode = "edit";
      openNote(path);
    } catch (e) { toast(String(e), "err"); }
  }
  $("[data-a=new]").onclick = () => newNote(null);

  // ----- drag notes and folders between folders (pointer events: HTML5 DnD is unreliable in the webview) -----
  const parentOf = (p: string) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const baseOf = (p: string) => p.split("/").pop()!;
  let dragJustEnded = false;
  listEl.addEventListener("click", (e) => { if (dragJustEnded) { e.stopPropagation(); e.preventDefault(); } }, true);
  listEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || q.value.trim().length >= 2) return;
    const t = e.target as HTMLElement;
    if (t.closest(".tree-add")) return;
    const note = t.closest<HTMLElement>(".note-item:not(.hit)");
    const row = t.closest<HTMLElement>(".tree-row");
    const src = note ? { path: note.dataset.p!, dir: false }
      : row?.parentElement?.dataset.dir !== undefined ? { path: row!.parentElement!.dataset.dir!, dir: true } : null;
    if (!src) return;
    const x0 = e.clientX, y0 = e.clientY;
    let ghost: HTMLElement | null = null;
    let target: string | null = null;
    let hoverDir: HTMLElement | null = null, hoverTimer = 0;
    const valid = (dst: string | null) => dst !== null && dst !== parentOf(src.path)
      && !(src.dir && (dst === src.path || dst.startsWith(src.path + "/")));
    const mark = (dst: string | null) => {
      listEl.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
      listEl.classList.toggle("drop-root", dst === "");
      if (dst) listEl.querySelector(`.tree-dir[data-dir="${CSS.escape(dst)}"] > .tree-row`)?.classList.add("drop-target");
    };
    const move = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        ghost.textContent = (src.dir ? "📁 " : "📄 ") + baseOf(src.path).replace(/\.md$/, "");
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY + 8}px`;
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      let dst: string | null = null;
      let dirEl: HTMLElement | null = null;
      if (el && listEl.contains(el) && !el.closest("[data-section]")) {
        const r = el.closest<HTMLElement>(".tree-row");
        const n = el.closest<HTMLElement>(".note-item");
        if (r?.parentElement?.dataset.dir !== undefined) { dirEl = r!.parentElement!; dst = dirEl.dataset.dir!; }
        else if (n) dst = parentOf(n.dataset.p!);
        else dst = "";
      }
      // hovering a closed folder for a moment opens it
      if (dirEl !== hoverDir) {
        clearTimeout(hoverTimer);
        hoverDir = dirEl;
        if (dirEl && !dirEl.classList.contains("open")) {
          const d = dirEl;
          hoverTimer = window.setTimeout(() => d.querySelector<HTMLElement>(":scope > .tree-row")?.click(), 700);
        }
      }
      target = valid(dst) ? dst : null;
      mark(target);
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      clearTimeout(hoverTimer);
      if (!ghost) return;
      ghost.remove();
      mark(null);
      dragJustEnded = true;
      setTimeout(() => { dragJustEnded = false; }, 0);
      if (target === null) return;
      const dest = (target ? `${target}/` : "") + baseOf(src.path);
      try {
        await invoke("note_move", { from: src.path, to: dest });
        // keep the open note and the expanded folders pointing at the new place
        if (current === src.path) current = dest;
        else if (src.dir && current?.startsWith(src.path + "/")) current = dest + current.slice(src.path.length);
        if (current) $(".note-path").textContent = current.replace(/\.md$/, "");
        if (src.dir) for (const d of [...openDirs]) if (d === src.path || d.startsWith(src.path + "/")) { openDirs.delete(d); openDirs.add(dest + d.slice(src.path.length)); }
        if (target) reveal(`${target}/x`);
        saveOpen();
        await loadVault();
        toast(`Перемещено в «${target || vault?.name || "/"}»`);
      } catch (err) { toast(String(err), "err"); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  let t = 0;
  q.oninput = () => { clearTimeout(t); t = window.setTimeout(drawList, 200); };

  setMode(mode);
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "notes" && !vault) loadVault(); });
  window.addEventListener("settings-changed", loadVault);
  loadVault();
}
