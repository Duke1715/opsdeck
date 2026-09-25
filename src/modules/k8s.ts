import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ask, esc, toast } from "./ui";
import { registerProvider } from "./palette";
import type { OpenTerminalDetail } from "./terminal";

type CtxInfo = {
  file: string; source: string; label: string; context: string; cluster: string;
  user: string; namespace: string; current: boolean; server: string;
};
type Ctx = { file: string; context: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any;
type Col = { h: string; v: (o: Obj) => string | number; sort?: (o: Obj) => string | number; cls?: (o: Obj) => string };

// ---------- column helpers ----------

const ts = (s?: string) => (s ? Date.parse(s) : 0);
function age(s?: string): string {
  if (!s) return "";
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(s)) / 1000));
  if (sec < 120) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 730 ? `${d}d` : `${Math.floor(d / 365)}y`;
}
const name: Col = { h: "Имя", v: (o) => o.metadata.name };
const ns: Col = { h: "Namespace", v: (o) => o.metadata.namespace ?? "" };
const ageCol: Col = { h: "Возраст", v: (o) => age(o.metadata.creationTimestamp), sort: (o) => -ts(o.metadata.creationTimestamp) };
const keys = (o: Obj) => Object.keys(o.data ?? {}).length + Object.keys(o.binaryData ?? {}).length;

function podStatus(p: Obj): string {
  if (p.metadata.deletionTimestamp) return "Terminating";
  for (const c of p.status?.initContainerStatuses ?? []) {
    const t = c.state?.terminated, w = c.state?.waiting;
    if (t && t.exitCode !== 0) return `Init:${t.reason ?? "Error"}`;
    if (w?.reason && w.reason !== "PodInitializing") return `Init:${w.reason}`;
  }
  let reason = p.status?.reason ?? p.status?.phase ?? "Unknown";
  for (const c of p.status?.containerStatuses ?? []) {
    if (c.state?.waiting?.reason) reason = c.state.waiting.reason;
    else if (c.state?.terminated?.reason && !c.ready) reason = c.state.terminated.reason;
  }
  return reason;
}
function statusClass(s: string): string {
  if (/^(Running|Active|Bound|Ready|Available|Normal|True)$/.test(s)) return "ok";
  if (/^(Succeeded|Completed)$/.test(s)) return "muted";
  if (/(Pending|Creating|Terminating|Init:|Unknown|Released)/.test(s)) return "warn";
  return "bad";
}
const ready = (have?: number, want?: number) => `${have ?? 0}/${want ?? 0}`;
const readyCls = (have?: number, want?: number) => ((have ?? 0) >= (want ?? 0) ? "ok" : "warn");
const nodeReady = (n: Obj) => {
  const c = (n.status?.conditions ?? []).find((c: Obj) => c.type === "Ready");
  const s = c?.status === "True" ? "Ready" : "NotReady";
  return n.spec?.unschedulable ? `${s},SchedulingDisabled` : s;
};

const KINDS: { id: string; label: string; group: string; namespaced: boolean; cols: Col[] }[] = [
  { id: "pods", label: "Pods", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Ready", v: (o) => { const cs = o.status?.containerStatuses ?? []; return `${cs.filter((c: Obj) => c.ready).length}/${o.spec.containers.length}`; } },
    { h: "Статус", v: podStatus, cls: (o) => statusClass(podStatus(o)) },
    { h: "Рестарты", v: (o) => (o.status?.containerStatuses ?? []).reduce((a: number, c: Obj) => a + (c.restartCount ?? 0), 0),
      cls: (o) => ((o.status?.containerStatuses ?? []).some((c: Obj) => c.restartCount > 0) ? "warn" : "") },
    { h: "Нода", v: (o) => o.spec.nodeName ?? "" },
    { h: "IP", v: (o) => o.status?.podIP ?? "" },
    ageCol] },
  { id: "deployments", label: "Deployments", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Ready", v: (o) => ready(o.status?.readyReplicas, o.spec.replicas), cls: (o) => readyCls(o.status?.readyReplicas, o.spec.replicas) },
    { h: "Up-to-date", v: (o) => o.status?.updatedReplicas ?? 0 },
    { h: "Available", v: (o) => o.status?.availableReplicas ?? 0 },
    ageCol] },
  { id: "statefulsets", label: "StatefulSets", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Ready", v: (o) => ready(o.status?.readyReplicas, o.spec.replicas), cls: (o) => readyCls(o.status?.readyReplicas, o.spec.replicas) },
    ageCol] },
  { id: "daemonsets", label: "DaemonSets", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Desired", v: (o) => o.status?.desiredNumberScheduled ?? 0 },
    { h: "Ready", v: (o) => o.status?.numberReady ?? 0, cls: (o) => readyCls(o.status?.numberReady, o.status?.desiredNumberScheduled) },
    ageCol] },
  { id: "replicasets", label: "ReplicaSets", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Ready", v: (o) => ready(o.status?.readyReplicas, o.spec.replicas), cls: (o) => readyCls(o.status?.readyReplicas, o.spec.replicas) },
    ageCol] },
  { id: "jobs", label: "Jobs", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Completions", v: (o) => `${o.status?.succeeded ?? 0}/${o.spec.completions ?? 1}` },
    { h: "Статус", v: (o) => (o.status?.failed ? "Failed" : o.status?.succeeded ? "Completed" : "Running"),
      cls: (o) => (o.status?.failed ? "bad" : o.status?.succeeded ? "muted" : "warn") },
    ageCol] },
  { id: "cronjobs", label: "CronJobs", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Расписание", v: (o) => o.spec.schedule },
    { h: "Suspend", v: (o) => (o.spec.suspend ? "да" : ""), cls: (o) => (o.spec.suspend ? "warn" : "") },
    { h: "Последний запуск", v: (o) => age(o.status?.lastScheduleTime), sort: (o) => -ts(o.status?.lastScheduleTime) },
    ageCol] },
  { id: "services", label: "Services", group: "Сеть", namespaced: true, cols: [
    name, ns,
    { h: "Тип", v: (o) => o.spec.type },
    { h: "Cluster IP", v: (o) => o.spec.clusterIP ?? "" },
    { h: "External", v: (o) => (o.status?.loadBalancer?.ingress ?? []).map((i: Obj) => i.ip ?? i.hostname).join(", ") },
    { h: "Порты", v: (o) => (o.spec.ports ?? []).map((p: Obj) => `${p.port}${p.nodePort ? ":" + p.nodePort : ""}/${p.protocol}`).join(", ") },
    ageCol] },
  { id: "ingresses", label: "Ingresses", group: "Сеть", namespaced: true, cols: [
    name, ns,
    { h: "Class", v: (o) => o.spec.ingressClassName ?? "" },
    { h: "Хосты", v: (o) => (o.spec.rules ?? []).map((r: Obj) => r.host ?? "*").join(", ") },
    { h: "Адрес", v: (o) => (o.status?.loadBalancer?.ingress ?? []).map((i: Obj) => i.ip ?? i.hostname).join(", ") },
    ageCol] },
  { id: "configmaps", label: "ConfigMaps", group: "Конфигурация", namespaced: true, cols: [name, ns, { h: "Ключи", v: keys }, ageCol] },
  { id: "secrets", label: "Secrets", group: "Конфигурация", namespaced: true, cols: [name, ns, { h: "Тип", v: (o) => o.type }, { h: "Ключи", v: keys }, ageCol] },
  { id: "persistentvolumeclaims", label: "PVC", group: "Хранилище", namespaced: true, cols: [
    name, ns,
    { h: "Статус", v: (o) => o.status?.phase ?? "", cls: (o) => statusClass(o.status?.phase ?? "") },
    { h: "Размер", v: (o) => o.status?.capacity?.storage ?? o.spec.resources?.requests?.storage ?? "" },
    { h: "StorageClass", v: (o) => o.spec.storageClassName ?? "" },
    ageCol] },
  { id: "persistentvolumes", label: "PV", group: "Хранилище", namespaced: false, cols: [
    name,
    { h: "Статус", v: (o) => o.status?.phase ?? "", cls: (o) => statusClass(o.status?.phase ?? "") },
    { h: "Размер", v: (o) => o.spec.capacity?.storage ?? "" },
    { h: "Claim", v: (o) => (o.spec.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : "") },
    ageCol] },
  { id: "nodes", label: "Nodes", group: "Кластер", namespaced: false, cols: [
    name,
    { h: "Статус", v: nodeReady, cls: (o) => (nodeReady(o) === "Ready" ? "ok" : "bad") },
    { h: "Роли", v: (o) => Object.keys(o.metadata.labels ?? {}).filter((l) => l.startsWith("node-role.kubernetes.io/")).map((l) => l.split("/")[1]).join(",") },
    { h: "Версия", v: (o) => o.status?.nodeInfo?.kubeletVersion ?? "" },
    { h: "IP", v: (o) => (o.status?.addresses ?? []).find((a: Obj) => a.type === "InternalIP")?.address ?? "" },
    ageCol] },
  { id: "namespaces", label: "Namespaces", group: "Кластер", namespaced: false, cols: [
    name, { h: "Статус", v: (o) => o.status?.phase ?? "", cls: (o) => statusClass(o.status?.phase ?? "") }, ageCol] },
  { id: "events", label: "Events", group: "Кластер", namespaced: true, cols: [
    { h: "Когда", v: (o) => age(o.lastTimestamp ?? o.eventTime ?? o.metadata.creationTimestamp), sort: (o) => -ts(o.lastTimestamp ?? o.eventTime ?? o.metadata.creationTimestamp) },
    { h: "Тип", v: (o) => o.type ?? "", cls: (o) => (o.type === "Warning" ? "warn" : "muted") },
    ns,
    { h: "Объект", v: (o) => `${o.involvedObject?.kind ?? ""}/${o.involvedObject?.name ?? ""}` },
    { h: "Причина", v: (o) => o.reason ?? "" },
    { h: "Сообщение", v: (o) => o.message ?? "", cls: () => "wrap" },
    { h: "×", v: (o) => o.count ?? 1 }] },
];

// ---------- persistence ----------

const store = {
  get(k: string) { try { return localStorage.getItem(`opsdeck.k8s.${k}`); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(`opsdeck.k8s.${k}`, v); } catch { /* ignore */ } },
};

// ---------- view ----------

export function mountK8s(root: HTMLElement) {
  root.classList.add("k8s");
  root.innerHTML = `
    <aside class="k8s-side">
      <div class="side-head"><span>Кластеры</span><button class="icon" data-act="import" title="Импорт kubeconfig">＋</button></div>
      <div class="ctx-list"></div>
      <div class="kind-list"></div>
    </aside>
    <div class="k8s-main">
      <div class="k8s-bar">
        <span class="ctx-title muted">выберите контекст</span>
        <span class="ro-badge" title="Изменения в этом контексте запрещены">🔒 только чтение</span>
        <select class="ns-select" title="Namespace"></select>
        <input class="filter" placeholder="фильтр…" spellcheck="false" />
        <span class="spacer"></span>
        <span class="count muted"></span>
        <label class="muted auto" title="Обновлять каждые 5 секунд"><input type="checkbox" class="auto-cb" checked /> авто</label>
        <button class="icon" data-act="refresh" title="Обновить">↻</button>
        <button data-act="shell" title="Терминал с KUBECONFIG этого контекста (kubectl, helm, k9s)">⎈ Терминал</button>
      </div>
      <div class="k8s-err err" hidden></div>
      <div class="table-wrap"><table class="res"><thead></thead><tbody></tbody></table></div>
      <div class="drawer" hidden>
        <div class="drawer-head">
          <strong class="obj-title"></strong>
          <div class="drawer-tabs"></div>
          <span class="spacer"></span>
          <div class="drawer-actions"></div>
          <button class="icon" data-act="close-drawer" title="Закрыть">×</button>
        </div>
        <div class="drawer-body"></div>
      </div>
    </div>
    <dialog class="import-dialog">
      <form method="dialog">
        <h3>Импорт kubeconfig</h3>
        <p class="muted">Вставьте содержимое kubeconfig или просто перетащите файл(ы) в окно на этой вкладке. Файлы копируются в ~/.config/opsdeck/kubeconfigs с правами 600.</p>
        <label>Имя <input name="name" placeholder="prod-cluster" spellcheck="false" /></label>
        <label>YAML <textarea name="yaml" rows="12" spellcheck="false" placeholder="apiVersion: v1&#10;kind: Config&#10;clusters: …"></textarea></label>
        <p class="err form-err"></p>
        <div class="actions"><button value="cancel" formnovalidate>Отмена</button><button value="ok" class="primary">Импортировать</button></div>
      </form>
    </dialog>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const ctxList = $(".ctx-list"), kindList = $(".kind-list"), nsSel = $<HTMLSelectElement>(".ns-select");
  const filterIn = $<HTMLInputElement>(".filter"), errBox = $(".k8s-err"), thead = $("thead"), tbody = $("tbody");
  const drawer = $(".drawer"), drawerBody = $(".drawer-body"), countEl = $(".count"), autoCb = $<HTMLInputElement>(".auto-cb");

  let contexts: CtxInfo[] = [];
  let ctx: CtxInfo | null = null;
  let kind = KINDS.find((k) => k.id === store.get("kind")) ?? KINDS[0];
  let items: Obj[] = [];
  let sortCol = 0, sortDir = 1;
  let selected: string | null = null; // "ns/name"
  let loadSeq = 0;
  let loading = false;
  let drawerCleanup: (() => void) | null = null;

  const ref = (): Ctx => ({ file: ctx!.file, context: ctx!.context });
  const keyOf = (o: Obj) => `${o.metadata.namespace ?? ""}/${o.metadata.name}`;
  const currentNs = () => (kind.namespaced ? nsSel.value : "");

  // ----- contexts -----

  type Prefs = { hidden: string[]; readonly: string[] };
  let prefs: Prefs = { hidden: [], readonly: [] };
  const ctxKey = (c: { file: string; context: string }) => `${c.file}|${c.context}`;
  const isReadonly = () => !!ctx && prefs.readonly.includes(ctxKey(ctx));

  async function setPref(c: CtxInfo, list: "hidden" | "readonly", on: boolean) {
    const k = ctxKey(c);
    prefs[list] = prefs[list].filter((x) => x !== k);
    if (on) prefs[list].push(k);
    await invoke("k8s_prefs_set", { prefs }).catch((e) => toast(String(e), "err"));
    if (list === "readonly") toast(on ? `🔒 ${c.context}: только чтение` : `${c.context}: изменения разрешены`);
    if (list === "hidden" && on) toast(`${c.context} скрыт — вернуть можно внизу списка`);
    loadContexts();
  }

  function ctxButton(c: CtxInfo) {
    const ro = prefs.readonly.includes(ctxKey(c));
    const b = document.createElement("div");
    b.className = "ctx-item";
    b.dataset.key = ctxKey(c);
    b.classList.toggle("active", !!ctx && ctxKey(ctx) === ctxKey(c));
    b.classList.toggle("ro", ro);
    b.title = `${c.server}\ncluster: ${c.cluster}\nuser: ${c.user}`;
    b.innerHTML = `<span class="ctx-name">${c.current ? "● " : ""}${esc(c.context)}${ro ? " 🔒" : ""}</span>
      <span class="ctx-server muted">${esc(c.server.replace(/^https?:\/\//, ""))}</span>
      <span class="ctx-acts">
        <button class="icon" data-p="ro" title="${ro ? "Разрешить изменения" : "Только чтение: запретить apply/delete/scale/restart/exec"}">${ro ? "🔓" : "🔒"}</button>
        <button class="icon" data-p="hide" title="Скрыть контекст из списка">🙈</button>
      </span>`;
    b.onclick = (e) => {
      const p = (e.target as HTMLElement).closest<HTMLElement>("[data-p]")?.dataset.p;
      if (p === "ro") return setPref(c, "readonly", !ro);
      if (p === "hide") return setPref(c, "hidden", true);
      selectContext(c);
    };
    return b;
  }

  /** Read-only context: banner + disabled mutating/exec controls. */
  function syncReadonly() {
    const ro = isReadonly();
    root.classList.toggle("readonly", ro);
    $("[data-act=shell]").toggleAttribute("disabled", ro);
    $("[data-act=shell]").title = ro ? "В режиме только чтения терминал с kubectl отключён" : "Терминал с KUBECONFIG этого контекста (kubectl, helm, k9s)";
  }

  async function loadContexts() {
    contexts = await invoke<CtxInfo[]>("k8s_contexts");
    const groups = new Map<string, CtxInfo[]>();
    prefs = await invoke<Prefs>("k8s_prefs_get").catch(() => ({ hidden: [], readonly: [] }));
    const visible = contexts.filter((c) => !prefs.hidden.includes(ctxKey(c)));
    const hidden = contexts.filter((c) => prefs.hidden.includes(ctxKey(c)));
    for (const c of visible) groups.set(c.file, [...(groups.get(c.file) ?? []), c]);
    ctxList.innerHTML = contexts.length ? "" : `<p class="muted pad">Нет kubeconfig. Нажмите ＋ или перетащите файл.</p>`;
    for (const [file, list] of groups) {
      const g = document.createElement("div");
      g.className = "ctx-group";
      g.innerHTML = `<div class="ctx-file" title="${esc(file)}"><span>${esc(list[0].label)}</span><span class="badge">${esc(list[0].source)}</span>
        ${list[0].source === "imported" ? `<button class="icon del" title="Удалить импортированный файл">×</button>` : ""}</div>`;
      g.querySelector<HTMLElement>(".del")?.addEventListener("click", async () => {
        if ((await ask("Удалить kubeconfig", `Удалить импортированный файл «${list[0].label}»?`, { ok: "Удалить", danger: true })) === null) return;
        await invoke("k8s_remove_source", { file }).catch((e) => toast(String(e), "err"));
        if (ctx?.file === file) ctx = null;
        loadContexts();
      });
      for (const c of list) g.appendChild(ctxButton(c));
      ctxList.appendChild(g);
    }
    if (hidden.length) {
      const g = document.createElement("details");
      g.className = "ctx-hidden";
      g.innerHTML = `<summary class="muted">Скрытые контексты (${hidden.length})</summary>`;
      for (const c of hidden) {
        const row = document.createElement("div");
        row.className = "ctx-hidden-row";
        row.innerHTML = `<span class="muted">${esc(c.context)}</span><button class="ghost" title="Вернуть в список">показать</button>`;
        row.querySelector("button")!.onclick = () => setPref(c, "hidden", false);
        g.appendChild(row);
      }
      ctxList.appendChild(g);
    }
    if (ctx && prefs.hidden.includes(ctxKey(ctx))) {
      // the selected context was just hidden: drop it
      ctx = null;
      store.set("ctx", "");
      $(".ctx-title").textContent = "выберите контекст";
      $(".ctx-title").classList.add("muted");
      items = [];
      closeDrawer();
      render();
    }
    syncReadonly();
    if (!ctx) {
      const last = store.get("ctx");
      const pick = contexts.find((c) => `${c.file}|${c.context}` === last);
      if (pick) selectContext(pick);
    }
  }

  async function selectContext(c: CtxInfo) {
    ctx = c;
    store.set("ctx", `${c.file}|${c.context}`);
    ctxList.querySelectorAll<HTMLElement>(".ctx-item").forEach((b) => b.classList.toggle("active", b.dataset.key === ctxKey(c)));
    syncReadonly();
    $(".ctx-title").textContent = c.context;
    $(".ctx-title").classList.remove("muted");
    closeDrawer();
    items = [];
    render();
    await loadNamespaces();
    refresh();
  }

  async function loadNamespaces() {
    const saved = store.get(`ns:${ctx!.file}|${ctx!.context}`);
    let names: string[] = [];
    try {
      names = (await invoke<Obj[]>("k8s_list", { ctx: ref(), kind: "namespaces", namespace: null })).map((n) => n.metadata.name).sort();
    } catch {
      // no RBAC for listing namespaces: offer the context default and manual entry
      names = [ctx!.namespace];
    }
    nsSel.innerHTML = "";
    nsSel.add(new Option("Все namespaces", ""));
    for (const n of names) nsSel.add(new Option(n, n));
    if (saved && !names.includes(saved) && saved !== "") nsSel.add(new Option(saved, saved));
    nsSel.add(new Option("Другой…", "__other"));
    nsSel.value = saved ?? (names.length > 1 ? "" : ctx!.namespace);
  }

  nsSel.onchange = async () => {
    if (nsSel.value === "__other") {
      const v = await ask("Namespace", "Имя namespace:", { input: "" });
      if (v) { if (![...nsSel.options].some((o) => o.value === v)) nsSel.add(new Option(v, v), nsSel.options.length - 1); nsSel.value = v; }
      else nsSel.value = "";
    }
    store.set(`ns:${ctx!.file}|${ctx!.context}`, nsSel.value);
    closeDrawer();
    refresh();
  };

  // ----- kinds -----

  function renderKinds() {
    kindList.innerHTML = "";
    let group = "";
    for (const k of KINDS) {
      if (k.group !== group) {
        group = k.group;
        kindList.insertAdjacentHTML("beforeend", `<div class="side-head small">${esc(group)}</div>`);
      }
      const b = document.createElement("button");
      b.className = "kind-item";
      b.classList.toggle("active", k === kind);
      b.textContent = k.label;
      b.onclick = () => {
        kind = k;
        store.set("kind", k.id);
        sortCol = 0; sortDir = 1;
        closeDrawer();
        items = [];
        renderKinds();
        render();
        refresh();
      };
      kindList.appendChild(b);
    }
    nsSel.disabled = !kind.namespaced;
  }

  // ----- table -----

  async function refresh() {
    if (!ctx || loading) return;
    loading = true;
    const seq = ++loadSeq;
    root.classList.add("loading");
    try {
      const list = await invoke<Obj[]>("k8s_list", { ctx: ref(), kind: kind.id, namespace: currentNs() || null });
      if (seq !== loadSeq) return;
      items = list;
      errBox.hidden = true;
      render();
    } catch (e) {
      if (seq !== loadSeq) return;
      errBox.hidden = false;
      errBox.textContent = String(e);
    } finally {
      loading = false;
      root.classList.remove("loading");
    }
  }

  function render() {
    const cols = kind.namespaced && currentNs() ? kind.cols.filter((c) => c !== ns) : kind.cols;
    if (sortCol >= cols.length) sortCol = 0;
    thead.innerHTML = `<tr>${cols.map((c, i) => `<th data-i="${i}" class="${i === sortCol ? (sortDir > 0 ? "asc" : "desc") : ""}">${esc(c.h)}</th>`).join("")}</tr>`;
    const q = filterIn.value.trim().toLowerCase();
    const rows = items.map((o) => ({ o, cells: cols.map((c) => String(c.v(o))) }))
      .filter((r) => !q || r.cells.join(" ").toLowerCase().includes(q));
    const sc = cols[sortCol];
    const sv = (o: Obj) => (sc.sort ?? sc.v)(o);
    rows.sort((a, b) => {
      const x = sv(a.o), y = sv(b.o);
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sortDir;
    });
    tbody.innerHTML = rows.map(({ o, cells }) => {
      const k = keyOf(o);
      return `<tr data-key="${esc(k)}" class="${k === selected ? "sel" : ""}">${cells.map((v, i) => `<td class="${cols[i].cls?.(o) ?? ""}">${esc(v)}</td>`).join("")}</tr>`;
    }).join("");
    countEl.textContent = ctx ? `${rows.length}${rows.length !== items.length ? ` из ${items.length}` : ""}` : "";
  }

  thead.onclick = (e) => {
    const th = (e.target as HTMLElement).closest("th");
    if (!th) return;
    const i = Number(th.dataset.i);
    sortDir = i === sortCol ? -sortDir : 1;
    sortCol = i;
    render();
  };
  tbody.onclick = (e) => {
    const tr = (e.target as HTMLElement).closest("tr");
    const o = tr && items.find((x) => keyOf(x) === tr.dataset.key);
    if (o) openDrawer(o);
  };
  filterIn.oninput = render;

  // ----- drawer -----

  function closeDrawer() {
    drawerCleanup?.();
    drawerCleanup = null;
    drawer.hidden = true;
    selected = null;
    tbody.querySelectorAll("tr.sel").forEach((r) => r.classList.remove("sel"));
  }

  function openDrawer(o: Obj) {
    drawerCleanup?.();
    drawerCleanup = null;
    selected = keyOf(o);
    tbody.querySelectorAll("tr").forEach((r) => r.classList.toggle("sel", r.dataset.key === selected));
    drawer.hidden = false;
    const objNs: string = o.metadata.namespace ?? "";
    $(".obj-title").textContent = `${kind.label.replace(/s$/, "")} ${objNs ? objNs + "/" : ""}${o.metadata.name}`;

    const tabs: [string, () => void][] = [["YAML", () => showYaml(o)]];
    if (kind.id === "pods") tabs.unshift(["Логи", () => showLogs(o)]);
    const tabsEl = $(".drawer-tabs");
    tabsEl.innerHTML = "";
    tabs.forEach(([label, fn], i) => {
      const b = document.createElement("button");
      b.className = "dtab";
      b.textContent = label;
      b.onclick = () => {
        drawerCleanup?.();
        drawerCleanup = null;
        tabsEl.querySelectorAll(".dtab").forEach((x) => x.classList.toggle("active", x === b));
        fn();
      };
      tabsEl.appendChild(b);
      if (i === 0) b.click();
    });

    const actions = $(".drawer-actions");
    actions.innerHTML = "";
    const act = (label: string, fn: () => void, cls = "ghost") => {
      const b = document.createElement("button");
      b.className = cls;
      b.textContent = label;
      b.onclick = fn;
      actions.appendChild(b);
    };
    const ro = isReadonly();
    if (kind.id === "pods" && !ro) {
      act("Shell", () => execShell(o));
    }
    if (kind.id === "pods") act("Port-forward", () => portForward(o, "pod"));
    if (kind.id === "services") act("Port-forward", () => portForward(o, "svc"));
    if (!ro) {
      if (["deployments", "statefulsets", "replicasets"].includes(kind.id)) act("Scale", () => scale(o));
      if (["deployments", "statefulsets", "daemonsets"].includes(kind.id)) act("Restart", () => restart(o));
      act("Удалить", () => del(o), "ghost danger");
    }
  }

  async function showYaml(o: Obj) {
    drawerBody.innerHTML = `<div class="yaml-pane"><textarea spellcheck="false" class="yaml">загрузка…</textarea>
      <div class="yaml-actions"><span class="err yaml-err"></span><span class="spacer"></span>
      <button class="ghost" data-y="reload">Перечитать</button><button class="primary" data-y="apply" ${isReadonly() ? "disabled title=\"Контекст в режиме только чтения\"" : ""}>Применить</button></div></div>`;
    const ta = drawerBody.querySelector<HTMLTextAreaElement>("textarea")!;
    const errEl = drawerBody.querySelector<HTMLElement>(".yaml-err")!;
    const load = async () => {
      errEl.textContent = "";
      try {
        ta.value = await invoke<string>("k8s_get_yaml", { ctx: ref(), kind: kind.id, namespace: o.metadata.namespace ?? null, name: o.metadata.name });
      } catch (e) { errEl.textContent = String(e); }
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab") { e.preventDefault(); ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end"); }
    });
    drawerBody.querySelector<HTMLElement>("[data-y=reload]")!.onclick = load;
    drawerBody.querySelector<HTMLElement>("[data-y=apply]")!.onclick = async () => {
      if ((await ask("Применить изменения", `Применить YAML к ${o.metadata.name} в контексте ${ctx!.context}?`, { ok: "Применить" })) === null) return;
      try {
        await invoke("k8s_apply_yaml", { ctx: ref(), kind: kind.id, namespace: o.metadata.namespace ?? null, yaml: ta.value });
        toast("Применено");
        await load();
        refresh();
      } catch (e) { errEl.textContent = String(e); }
    };
    await load();
  }

  function showLogs(o: Obj) {
    const containers: string[] = [...(o.spec.initContainers ?? []), ...o.spec.containers].map((c: Obj) => c.name);
    drawerBody.innerHTML = `<div class="logs-pane">
      <div class="logs-bar">
        <select class="lc">${containers.map((c) => `<option ${c === o.spec.containers[0].name ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <select class="lt"><option value="100">100 строк</option><option value="500" selected>500 строк</option><option value="2000">2000 строк</option><option value="10000">10000 строк</option></select>
        <label class="muted"><input type="checkbox" class="lp" /> previous</label>
        <label class="muted"><input type="checkbox" class="lts" /> время</label>
        <span class="spacer"></span>
        <span class="lstate muted"></span>
        <button class="ghost" data-l="ai" title="Отправить выделение (или последние 150 строк) в AI-панель">⇢ в AI</button>
        <button class="ghost" data-l="clear">Очистить</button>
      </div>
      <div class="logs-term"></div></div>`;
    const q = <T extends HTMLElement>(s: string) => drawerBody.querySelector<T>(s)!;
    const term = new Terminal({ fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 12, scrollback: 50000,
      convertEol: true, disableStdin: true, theme: { background: "#0f1117", foreground: "#d6deeb", selectionBackground: "#2b3a55" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(q(".logs-term"));
    const ro = new ResizeObserver(() => { if (q<HTMLElement>(".logs-term").clientWidth) fit.fit(); });
    ro.observe(q(".logs-term"));

    const id = `log${Date.now()}`;
    let unlisten: UnlistenFn[] = [];
    const state = q(".lstate");
    const stop = () => { invoke("k8s_logs_stop", { id }); unlisten.forEach((u) => u()); unlisten = []; };

    const start = async () => {
      stop();
      term.reset();
      state.textContent = "подключение…";
      unlisten = [
        await listen<string[]>(`k8s-log-${id}`, (e) => { term.write(e.payload.join("\n") + "\n"); state.textContent = "● live"; }),
        await listen<string | null>(`k8s-log-end-${id}`, (e) => { state.textContent = e.payload ? `ошибка: ${e.payload}` : "поток завершён"; }),
      ];
      try {
        await invoke("k8s_logs_start", { ctx: ref(), id, req: {
          namespace: o.metadata.namespace, pod: o.metadata.name, container: q<HTMLSelectElement>(".lc").value,
          tail: Number(q<HTMLSelectElement>(".lt").value), previous: q<HTMLInputElement>(".lp").checked,
          timestamps: q<HTMLInputElement>(".lts").checked } });
      } catch (e) {
        state.textContent = "";
        term.write(`\x1b[31m${String(e)}\x1b[0m\n`);
      }
    };
    [".lc", ".lt", ".lp", ".lts"].forEach((s) => q(s).addEventListener("change", start));
    q<HTMLElement>("[data-l=clear]").onclick = () => term.clear();
    q<HTMLElement>("[data-l=ai]").onclick = () => {
      let text = term.getSelection().trim();
      if (!text) {
        const b = term.buffer.active, lines: string[] = [];
        for (let i = Math.max(0, b.length - 150); i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
        text = lines.join("\n").trim();
      }
      if (text) window.dispatchEvent(new CustomEvent("send-to-ai", { detail: `Логи пода ${o.metadata.namespace}/${o.metadata.name} (${ctx!.context}):\n${text}` }));
    };
    drawerCleanup = () => { stop(); ro.disconnect(); term.dispose(); };
    requestAnimationFrame(() => { fit.fit(); start(); });
  }

  // ----- actions -----

  async function kubectlTab(title: string, args: string[], nsForShell?: string) {
    try {
      const path = await invoke<string>("k8s_shell_config", { ctx: ref(), namespace: nsForShell ?? null });
      const detail: OpenTerminalDetail = args.length
        ? { title, program: "kubectl", args, env: { KUBECONFIG: path }, keepOpen: true }
        : { title, env: { KUBECONFIG: path } };
      window.dispatchEvent(new CustomEvent("open-terminal", { detail }));
    } catch (e) { toast(String(e), "err"); }
  }

  function execShell(o: Obj) {
    const c = o.spec.containers.length > 1 ? drawerBody.querySelector<HTMLSelectElement>(".lc")?.value ?? o.spec.containers[0].name : o.spec.containers[0].name;
    kubectlTab(`⎈ ${o.metadata.name}`, ["exec", "-it", "-n", o.metadata.namespace, o.metadata.name, "-c", c, "--",
      "sh", "-c", "command -v bash >/dev/null && exec bash || exec sh"]);
  }

  async function portForward(o: Obj, type: "pod" | "svc") {
    const port = type === "svc" ? o.spec.ports?.[0]?.port : o.spec.containers.flatMap((c: Obj) => c.ports ?? [])[0]?.containerPort;
    const spec = await ask("Port-forward", `${type}/${o.metadata.name} → localhost. Формат: локальный:удалённый`, { input: port ? `${port}:${port}` : "8080:80", ok: "Запустить" });
    if (!spec || !/^\d+(:\d+)?$/.test(spec)) return;
    kubectlTab(`⇄ ${o.metadata.name} ${spec}`, ["port-forward", "-n", o.metadata.namespace, `${type}/${o.metadata.name}`, spec]);
  }

  async function scale(o: Obj) {
    const v = await ask("Scale", `${o.metadata.namespace}/${o.metadata.name} (${ctx!.context}): число реплик`, { input: String(o.spec.replicas ?? 1), ok: "Применить" });
    if (v === null || !/^\d+$/.test(v)) return;
    invoke("k8s_scale", { ctx: ref(), kind: kind.id, namespace: o.metadata.namespace, name: o.metadata.name, replicas: Number(v) })
      .then(() => { toast(`Scale → ${v}`); refresh(); }, (e) => toast(String(e), "err"));
  }

  async function restart(o: Obj) {
    if ((await ask("Rollout restart", `Перезапустить ${o.metadata.namespace}/${o.metadata.name} в контексте ${ctx!.context}?`, { ok: "Перезапустить" })) === null) return;
    invoke("k8s_restart", { ctx: ref(), kind: kind.id, namespace: o.metadata.namespace, name: o.metadata.name })
      .then(() => { toast("Restart запущен"); refresh(); }, (e) => toast(String(e), "err"));
  }

  async function del(o: Obj) {
    const full = `${o.metadata.namespace ? o.metadata.namespace + "/" : ""}${o.metadata.name}`;
    const v = await ask("Удаление", `Удалить ${kind.label.replace(/s$/, "")} ${full} в контексте ${ctx!.context}? Для подтверждения введите имя объекта.`,
      { input: "", placeholder: o.metadata.name, ok: "Удалить", danger: true });
    if (v !== o.metadata.name) { if (v !== null) toast("Имя не совпало — ничего не удалено", "err"); return; }
    invoke("k8s_delete", { ctx: ref(), kind: kind.id, namespace: o.metadata.namespace ?? null, name: o.metadata.name })
      .then(() => { toast(`Удалено: ${full}`); closeDrawer(); refresh(); }, (e) => toast(String(e), "err"));
  }

  // ----- import -----

  const dialog = $<HTMLDialogElement>(".import-dialog");
  const dform = dialog.querySelector("form")!;
  $("[data-act=import]").onclick = () => { dform.reset(); dform.querySelector<HTMLElement>(".form-err")!.textContent = ""; dialog.showModal(); };
  dform.addEventListener("submit", async (e) => {
    if ((e.submitter as HTMLButtonElement | null)?.value !== "ok") return;
    e.preventDefault();
    const f = (n: string) => (dform.elements.namedItem(n) as HTMLInputElement).value;
    try {
      const n = await invoke<number>("k8s_import", { name: f("name") || null, yaml: f("yaml"), path: null });
      dialog.close();
      toast(`Импортировано контекстов: ${n}`);
      loadContexts();
    } catch (err) { dform.querySelector<HTMLElement>(".form-err")!.textContent = String(err); }
  });

  getCurrentWebview().onDragDropEvent(async (e) => {
    if (root.hidden) return;
    root.classList.toggle("dragover", e.payload.type === "over" || e.payload.type === "enter");
    if (e.payload.type !== "drop") return;
    root.classList.remove("dragover");
    for (const path of e.payload.paths) {
      try {
        const n = await invoke<number>("k8s_import", { name: null, yaml: null, path });
        toast(`${path.split("/").pop()}: контекстов ${n}`);
      } catch (err) { toast(`${path.split("/").pop()}: ${err}`, "err"); }
    }
    loadContexts();
  });

  // ----- toolbar / timers -----

  $("[data-act=refresh]").onclick = () => refresh();
  $("[data-act=close-drawer]").onclick = closeDrawer;
  $("[data-act=shell]").onclick = () => ctx && kubectlTab(`⎈ ${ctx.context}${nsSel.value ? "/" + nsSel.value : ""}`, [], nsSel.value || undefined);
  autoCb.checked = store.get("auto") !== "0";
  autoCb.onchange = () => store.set("auto", autoCb.checked ? "1" : "0");

  setInterval(() => {
    if (!root.hidden && autoCb.checked && !document.hidden) refresh();
  }, 5000);
  window.addEventListener("view-shown", (e) => {
    if ((e as CustomEvent).detail === "k8s") { loadContexts(); refresh(); }
  });

  registerProvider(() => {
    const go = () => window.dispatchEvent(new CustomEvent("show-view", { detail: "k8s" }));
    const visible = contexts.filter((c) => !prefs.hidden.includes(ctxKey(c)));
    return [
      ...visible.map((c) => ({ group: "Kubernetes", title: `Контекст: ${c.context}`, hint: c.server, run: () => { go(); selectContext(c); } })),
      ...KINDS.map((k) => ({ group: "Kubernetes", title: `Ресурсы: ${k.label}`, hint: ctx?.context, run: () => { go(); kindList.querySelectorAll<HTMLElement>(".kind-item").forEach((b) => { if (b.textContent === k.label) b.click(); }); } })),
      ...(ctx && !isReadonly() ? [{ group: "Kubernetes", title: `Терминал kubectl: ${ctx.context}`, run: () => $("[data-act=shell]").click() }] : []),
    ];
  });

  renderKinds();
  render();
  loadContexts();
}
