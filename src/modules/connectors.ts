import { helpBtn } from "./help";
import { invoke } from "@tauri-apps/api/core";
import { pickEntry } from "./keepass";
import { ask, esc, toast } from "./ui";
import { registerProvider } from "./palette";

type Connector = { id: string; kind: string; name: string; group?: string; url: string; username: string; auth: string; keepass_entry?: string; ingest_token?: string };

const KINDS: Record<string, { label: string; auth: string[]; hint: string }> = {
  grafana: { label: "Grafana", auth: ["keepass", "password", "token", "none"], hint: "Логин/пароль — автологин в панель и сбор алертов. Токен service account — только для сбора алертов (роль Viewer достаточно), в панель входите вручную." },
  argocd: { label: "ArgoCD", auth: ["keepass", "password", "token"], hint: "admin/пароль или API-токен (argocd account generate-token)." },
  gitlab: { label: "GitLab", auth: ["keepass", "password", "none"], hint: "Логин/пароль заполняются в форму входа. 2FA вводится руками." },
  alertmanager: { label: "Alertmanager", auth: ["none", "password", "token", "keepass"], hint: "Prometheus Alertmanager, URL вида http://alertmanager:9093. OpsDeck опрашивает /api/v2/alerts — алерты появятся в 🔔." },
  ai: { label: "AI / анализатор", auth: ["none", "token", "password", "keepass"], hint: "Локальный или удалённый анализатор логов и алертов. Как подключить — ниже." },
  generic: { label: "Другое (URL)", auth: ["none"], hint: "Просто открыть веб-интерфейс в отдельном окне." },
};
const AUTH_LABEL: Record<string, string> = { keepass: "из KeePass", password: "логин/пароль", token: "токен", none: "без автологина" };

export function mountConnectors(root: HTMLElement) {
  root.classList.add("web");
  root.innerHTML = `
    <div class="tabbar web-tabs">
      <div class="tab active" data-t="home">☰ Панели</div>
      <div class="tabs web-tablist"></div>
      <span class="spacer"></span>
      ${helpBtn("web")}
      <span class="web-nav" hidden>
        <button class="icon" data-n="back" title="Назад">←</button>
        <button class="icon" data-n="forward" title="Вперёд">→</button>
        <button class="icon" data-n="reload" title="Обновить">↻</button>
        <button class="icon" data-n="home" title="На стартовую страницу">⌂</button>
        <button class="icon" data-n="window" title="Открыть в отдельном окне">⧉</button>
      </span>
    </div>
    <div class="web-slot" hidden></div>
    <div class="page web-home">
      <div class="page-head">
        <h2>Веб-панели</h2>
        <button class="primary" data-act="add">＋ Добавить</button>
      </div>
      <p class="muted">Grafana, ArgoCD, GitLab и любые другие веб-интерфейсы открываются вкладками здесь же (или в отдельном окне — ⧉) с автологином. Секреты хранятся в системном keyring или KeePass.</p>
      <div class="cards"></div>
      <dialog class="conn-dialog">
        <form method="dialog">
          <h3>Коннектор</h3>
          <label>Тип <select name="kind"></select></label>
          <div class="grid2">
            <label>Название <input name="name" required placeholder="prod grafana" /></label>
            <label>Группа <input name="group" list="conn-groups" placeholder="Мониторинг, CI/CD…" /></label>
          </div>
          <datalist id="conn-groups"></datalist>
          <label><span class="url-label">URL</span> <input name="url" type="url" required placeholder="https://grafana.example.com" /></label>
          <label>Авторизация <select name="auth"></select></label>
          <div data-a="keepass" class="kp-bind"><span class="kp-bound muted">запись не выбрана</span><button type="button" data-a="pick">Выбрать запись…</button></div>
          <label data-a="user">Логин <input name="username" autocomplete="off" /></label>
          <label data-a="secret"><span class="secret-label">Пароль</span> <input name="secret" type="password" autocomplete="new-password" placeholder="" /></label>
          <p class="muted hint"></p>
          <div class="ai-help" hidden></div>
          <div class="src-help" hidden></div>
          <div class="check-result" hidden></div>
          <p class="err form-err"></p>
          <div class="actions">
            <button value="cancel" formnovalidate>Отмена</button>
            <button value="check" class="ghost" data-check hidden title="Сохранить и сразу опросить источник алертов">Сохранить и проверить</button>
            <button value="save" class="primary">Сохранить</button>
          </div>
        </form>
      </dialog>
    </div>`;

  const cards = root.querySelector<HTMLElement>(".cards")!;
  const dialog = root.querySelector<HTMLDialogElement>("dialog")!;
  const form = dialog.querySelector("form")!;
  const f = (n: string) => form.elements.namedItem(n) as HTMLInputElement & HTMLSelectElement;
  let editing: Connector | null = null;
  let boundEntry = "";
  const setBound = (id: string, label?: string) => {
    boundEntry = id;
    form.querySelector(".kp-bound")!.textContent = id ? (label ?? "запись выбрана") : "запись не выбрана";
  };
  form.querySelector<HTMLElement>("[data-a=pick]")!.onclick = async () => {
    const e = await pickEntry();
    if (e) setBound(e.id, `${e.title}${e.username ? " · " + e.username : ""}`);
  };

  for (const [k, v] of Object.entries(KINDS)) f("kind").add(new Option(v.label, k));

  const syncForm = () => {
    const kind = KINDS[f("kind").value];
    const authSel = f("auth");
    const prev = authSel.value;
    authSel.innerHTML = "";
    for (const a of kind.auth) authSel.add(new Option(AUTH_LABEL[a], a));
    authSel.value = kind.auth.includes(prev) ? prev : kind.auth[0];
    const auth = authSel.value;
    form.querySelector<HTMLElement>("[data-a=user]")!.hidden = auth !== "password" && auth !== "keepass";
    form.querySelector<HTMLElement>("[data-a=secret]")!.hidden = auth === "none" || auth === "keepass";
    form.querySelector<HTMLElement>("[data-a=keepass]")!.hidden = auth !== "keepass";
    f("username").placeholder = auth === "keepass" ? "из записи KeePass" : "";
    form.querySelector<HTMLElement>(".secret-label")!.textContent = auth === "token" ? "Токен" : "Пароль";
    f("secret").placeholder = editing ? "оставьте пустым, чтобы не менять" : "";
    form.querySelector<HTMLElement>(".hint")!.textContent = kind.hint;
    const ai = f("kind").value === "ai";
    f("url").required = !ai;
    f("url").placeholder = ai ? "необязательно: http://analyzer:8080/findings" : "https://grafana.example.com";
    form.querySelector<HTMLElement>(".url-label")!.textContent = ai ? "URL ленты (pull, необязательно)" : "URL";
    renderAiHelp();
    renderSourceHelp();
  };

  /** Step-by-step setup for alert sources, shown right in the dialog. */
  function renderSourceHelp() {
    const kind = f("kind").value, auth = f("auth").value;
    const box = form.querySelector<HTMLElement>(".src-help")!;
    const canCheck = kind === "grafana" || kind === "alertmanager" || (kind === "ai" && !!f("url").value.trim());
    form.querySelector<HTMLElement>("[data-check]")!.hidden = !canCheck || (kind === "grafana" && auth === "none");
    box.hidden = kind !== "grafana" && kind !== "alertmanager";
    if (kind === "grafana") {
      box.innerHTML = `<div class="side-head small">Сбор алертов из этой Grafana</div>
        <ol>
          <li>В самой Grafana ничего настраивать не нужно (ни contact point, ни webhook) — OpsDeck сам забирает алерты раз в минуту.</li>
          <li>Нужен доступ на чтение. Проще всего токен: Grafana → <b>Administration → Users and access → Service accounts</b> → <b>Add service account</b> (роль <b>Viewer</b>) → <b>Add service account token</b> → скопируйте <code>glsa_…</code>.</li>
          <li>Здесь: Авторизация = <b>токен</b>, вставьте его, нажмите <b>Сохранить и проверить</b>.</li>
        </ol>
        <p class="muted">${auth === "token"
          ? "С токеном собираются только алерты; сама панель откроется без автовхода."
          : auth === "none"
            ? "Без авторизации алерты не собираются — это будет просто веб-панель."
            : "Логин/пароль (или KeePass) дают и автовход в панель, и сбор алертов."}</p>`;
    } else if (kind === "alertmanager") {
      box.innerHTML = `<div class="side-head small">Сбор алертов из Alertmanager</div>
        <ol><li>URL — адрес Alertmanager, например <code>http://alertmanager.monitoring:9093</code> (доступный с этого компьютера, через VPN тоже).</li>
        <li>Если перед ним нет авторизации — оставьте «без автологина»; иначе логин/пароль или токен.</li>
        <li><b>Сохранить и проверить</b>.</li></ol>`;
    }
  }

  let ingestPort = 9095;
  invoke<{ ingest_port: number }>("alerts_config_get").then((c) => (ingestPort = c.ingest_port)).catch(() => {});

  /** Connection guide for an AI analyzer: push to loopback with the connector's token, or pull a feed. */
  function renderAiHelp() {
    const box = form.querySelector<HTMLElement>(".ai-help")!;
    box.hidden = f("kind").value !== "ai";
    if (box.hidden) return;
    const token = editing?.ingest_token;
    const endpoint = `http://127.0.0.1:${ingestPort}/api/v1/findings`;
    const curl = `curl -sS ${endpoint} \\
  -H "Authorization: Bearer ${token ?? "<токен>"}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Всплеск 5xx в ingress","severity":"warning","summary":"500-е ошибки выросли в 8 раз за 10 минут","labels":{"namespace":"prod","app":"api"}}'`;
    const format = `{
  "title": "Короткий заголовок",           // обязательно
  "severity": "critical | warning | info",
  "summary": "одна строка",
  "details": "подробный разбор, можно многострочно",
  "labels": {"namespace": "prod", "pod": "api-7d9f"},
  "links": [{"title": "Grafana", "url": "https://..."}],
  "id": "стабильный-id",                    // повтор с тем же id обновит находку
  "status": "firing"                        // "resolved" — закрыть
}`;
    box.innerHTML = `
      <div class="side-head small">Push — анализатор на этом компьютере</div>
      <p class="muted">OpsDeck принимает находки только с 127.0.0.1 (из сети недоступен). Можно слать массив или {"findings": [...]}; алерты в формате Alertmanager — на /api/v1/alerts.</p>
      <div class="kv"><span>Адрес</span><code>${esc(endpoint)}</code><button type="button" class="icon" data-copy="${esc(endpoint)}" title="Скопировать">⧉</button></div>
      <div class="kv"><span>Токен</span>${token
        ? `<code>${esc(token)}</code><button type="button" class="icon" data-copy="${esc(token)}" title="Скопировать">⧉</button><button type="button" class="ghost" data-regen>новый</button>`
        : `<span class="muted">появится после сохранения</span>`}</div>
      <div class="kv-block"><div class="row"><span class="muted">Проверка</span><span class="spacer"></span><button type="button" class="icon" data-copy="${esc(curl)}" title="Скопировать">⧉</button></div><pre>${esc(curl)}</pre></div>
      <details><summary class="muted">Формат находки</summary><pre>${esc(format)}</pre></details>
      <div class="side-head small">Pull — анализатор на другой машине</div>
      <p class="muted">Укажите выше URL, по которому он отдаёт JSON с теми же объектами (массив или {"findings": [...]}). OpsDeck будет опрашивать его вместе с Grafana (интервал — в ⚙ раздела 🔔); находки, пропавшие из ленты, закрываются. Авторизация — как выбрано выше.</p>`;
  }

  form.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const copy = t.closest<HTMLElement>("[data-copy]")?.dataset.copy;
    if (copy) { await invoke("clip_write", { text: copy }); toast("Скопировано"); return; }
    if (t.closest("[data-regen]") && editing) {
      if ((await ask("Новый токен", "Старый токен перестанет работать сразу. Продолжить?", { ok: "Сменить" })) === null) return;
      editing.ingest_token = await invoke<string>("connector_regen_token", { id: editing.id });
      renderAiHelp();
    }
  });
  f("kind").onchange = syncForm;
  f("auth").onchange = syncForm;
  f("url").addEventListener("input", () => renderSourceHelp());

  /** Save, then poll this source once and show the outcome in the dialog. */
  async function saveAndCheck() {
    const res = form.querySelector<HTMLElement>(".check-result")!;
    res.hidden = false;
    res.className = "check-result";
    res.textContent = "Сохраняю и опрашиваю…";
    const connector: Connector = {
      id: editing?.id ?? crypto.randomUUID(),
      kind: f("kind").value, name: f("name").value.trim(), group: f("group").value.trim(), url: f("url").value.trim(),
      username: f("username").value.trim(), auth: f("auth").value,
      keepass_entry: f("auth").value === "keepass" ? boundEntry : "",
      ingest_token: editing?.ingest_token ?? "",
    };
    if (!connector.name) connector.name = new URL(connector.url || "http://x").hostname;
    try {
      await invoke("connector_save", { connector, secret: f("secret").value || null });
      editing = (await invoke<Connector[]>("connectors_list")).find((c) => c.id === connector.id) ?? null;
      f("secret").value = "";
      refresh();
      const n = await invoke<number>("alerts_test_source", { id: connector.id });
      res.classList.add("ok");
      res.textContent = `✓ Работает: активных алертов сейчас ${n}. Они в разделе 🔔, дальше опрос идёт сам.`;
    } catch (err) {
      res.classList.add("bad");
      res.textContent = `✗ ${err}`;
    }
  }

  const openDialog = (c: Connector | null, presetKind?: string) => {
    editing = c;
    form.reset();
    form.querySelector<HTMLElement>(".check-result")!.hidden = true;
    form.querySelector<HTMLElement>(".form-err")!.textContent = "";
    f("kind").value = c?.kind ?? presetKind ?? "grafana";
    f("name").value = c?.name ?? "";
    f("group").value = c?.group ?? "";
    form.querySelector("#conn-groups")!.innerHTML = [...new Set(allConnectors.map((x) => x.group).filter(Boolean))]
      .map((g) => `<option value="${esc(g!)}">`).join("");
    f("url").value = c?.url ?? "";
    f("username").value = c?.username ?? "";
    setBound(c?.keepass_entry ?? "");
    syncForm();
    if (c) { f("auth").value = c.auth; syncForm(); }
    dialog.showModal();
  };

  form.addEventListener("submit", async (e) => {
    const action = (e.submitter as HTMLButtonElement | null)?.value;
    if (action === "check") {
      e.preventDefault();
      return saveAndCheck();
    }
    if (action !== "save") return;
    e.preventDefault();
    const connector: Connector = {
      id: editing?.id ?? crypto.randomUUID(),
      kind: f("kind").value, name: f("name").value.trim(), group: f("group").value.trim(), url: f("url").value.trim(),
      username: f("username").value.trim(), auth: f("auth").value,
      keepass_entry: f("auth").value === "keepass" ? boundEntry : "",
      ingest_token: editing?.ingest_token ?? "",
    };
    try {
      await invoke("connector_save", { connector, secret: f("secret").value || null });
      // settings changed: the embedded panel is recreated with them on next show
      if (editing) invoke("web_embed_close", { id: connector.id }).catch(() => {});
      if (connector.kind === "ai" && !editing?.ingest_token) {
        // first save of an analyzer: keep the dialog open to show its token and the curl example
        const saved = (await invoke<Connector[]>("connectors_list")).find((c) => c.id === connector.id);
        editing = saved ?? null;
        renderAiHelp();
        toast("Сохранено — ниже токен и пример подключения");
        refresh();
        return;
      }
      dialog.close();
      refresh();
    } catch (err) {
      form.querySelector<HTMLElement>(".form-err")!.textContent = String(err);
    }
  });

  let allConnectors: Connector[] = [];
  const closedRows = new Set<string>((() => { try { return JSON.parse(localStorage.getItem("opsdeck.web.closedRows") ?? "[]"); } catch { return []; } })());

  async function refresh() {
    const list = await invoke<Connector[]>("connectors_list").catch((e) => {
      cards.textContent = String(e);
      return [];
    });
    allConnectors = list;
    cards.innerHTML = list.length ? "" : `<p class="muted">Пока пусто — добавьте Grafana, ArgoCD или GitLab.</p>`;
    // rows like on a Grafana dashboard: one collapsible row per group, ungrouped panels first
    const rows = new Map<string, Connector[]>();
    for (const c of [...list].sort((a, b) => a.name.localeCompare(b.name))) rows.set(c.group ?? "", [...(rows.get(c.group ?? "") ?? []), c]);
    const order = [...rows.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
    const grouped = order.some((g) => g !== "");
    const containers = new Map<string, HTMLElement>();
    for (const g of order) {
      if (!grouped) { containers.set(g, cards); break; }
      const row = document.createElement("details");
      row.className = "conn-row";
      row.open = !closedRows.has(g);
      row.innerHTML = `<summary><span class="conn-row-title">${esc(g || "Без группы")}</span><span class="conn-row-count">${rows.get(g)!.length}</span></summary><div class="cards"></div>`;
      row.addEventListener("toggle", () => {
        row.open ? closedRows.delete(g) : closedRows.add(g);
        try { localStorage.setItem("opsdeck.web.closedRows", JSON.stringify([...closedRows])); } catch { /* ignore */ }
      });
      cards.appendChild(row);
      containers.set(g, row.querySelector<HTMLElement>(".cards")!);
    }
    cards.classList.toggle("grouped", grouped);
    for (const c of list) {
      const card = document.createElement("div");
      card.className = `card kind-${c.kind}`;
      card.innerHTML = `
        <div class="card-kind"></div>
        <div class="card-name"></div>
        <div class="card-url muted"></div>
        <div class="card-actions">
          <button class="primary" data-act="open">Открыть</button>
          <button class="ghost" data-act="window" title="Открыть в отдельном окне">⧉</button>
          <span class="spacer"></span>
          <button class="icon" data-act="edit" title="Изменить">✎</button>
          <button class="icon danger" data-act="del" title="Удалить">🗑</button>
        </div>`;
      card.querySelector(".card-kind")!.textContent = KINDS[c.kind]?.label ?? c.kind;
      card.querySelector(".card-name")!.textContent = c.name;
      card.querySelector(".card-url")!.textContent = c.url || (c.kind === "ai" ? `push → 127.0.0.1:${ingestPort}` : "");
      if (!c.url || c.kind === "ai") card.querySelectorAll<HTMLElement>("[data-act=open], [data-act=window]").forEach((b) => b.remove());
      if (c.kind === "ai") card.querySelector<HTMLElement>("[data-act=edit]")!.title = "Подключение: адрес, токен, пример";
      card.querySelector<HTMLElement>("[data-act=open]")!.onclick = () => openTab(c);
      card.querySelector<HTMLElement>("[data-act=window]")!.onclick = () =>
        invoke("connector_open", { id: c.id }).catch((e) => toast(String(e), "err"));
      card.querySelector<HTMLElement>("[data-act=edit]")!.onclick = () => openDialog(c);
      card.querySelector<HTMLElement>("[data-act=del]")!.onclick = async () => {
        if ((await ask("Удалить коннектор", `Удалить «${c.name}»? Сохранённый секрет тоже будет удалён.`, { ok: "Удалить", danger: true })) !== null) {
          closeTab(c.id);
          await invoke("connector_delete", { id: c.id });
          refresh();
        }
      };
      (containers.get(c.group ?? "") ?? cards).appendChild(card);
    }
  }

  // ----- tabs with embedded panels -----

  type WebTab = { id: string; name: string; kind: string };
  const tablist = root.querySelector<HTMLElement>(".web-tablist")!;
  const slot = root.querySelector<HTMLElement>(".web-slot")!;
  const home = root.querySelector<HTMLElement>(".web-home")!;
  const nav = root.querySelector<HTMLElement>(".web-nav")!;
  const homeTab = root.querySelector<HTMLElement>("[data-t=home]")!;
  let tabs: WebTab[] = (() => { try { return JSON.parse(localStorage.getItem("opsdeck.web.tabs") ?? "[]"); } catch { return []; } })();
  let active = "home";
  let pendingUrl: { id: string; url: string } | null = null;
  let overlays = 0;
  const saveTabs = () => { try { localStorage.setItem("opsdeck.web.tabs", JSON.stringify(tabs)); } catch { /* ignore */ } };

  /** The panel is a native webview on top of this page: only show it while nothing should cover it. */
  const visible = () => !root.hidden && active !== "home" && overlays === 0;

  function drawTabs() {
    tablist.innerHTML = tabs.map((t) => `<div class="tab ${t.id === active ? "active" : ""}" data-t="${esc(t.id)}">
      <span class="dot kind-${esc(t.kind)}"></span><span class="label">${esc(t.name)}</span><span class="x" title="Закрыть">×</span></div>`).join("");
    homeTab.classList.toggle("active", active === "home");
    nav.hidden = active === "home";
  }

  let placing = false;
  function place() {
    if (placing) return;
    placing = true;
    requestAnimationFrame(async () => {
      placing = false;
      if (!visible()) return;
      const r = slot.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const url = pendingUrl?.id === active ? pendingUrl.url : null;
      pendingUrl = null;
      await invoke("web_embed_show", { id: active, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, url })
        .catch((e) => { toast(String(e), "err"); });
    });
  }

  function activate(id: string) {
    active = id;
    slot.hidden = id === "home";
    home.hidden = id !== "home";
    drawTabs();
    invoke("web_embed_hide", { id: null }).finally(place);
  }

  function openTab(c: Connector) {
    if (!tabs.some((t) => t.id === c.id)) {
      tabs.push({ id: c.id, name: c.name, kind: c.kind });
      saveTabs();
    }
    window.dispatchEvent(new CustomEvent("show-view", { detail: "web" }));
    activate(c.id);
  }

  function closeTab(id: string) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    tabs.splice(i, 1);
    saveTabs();
    invoke("web_embed_close", { id }).catch(() => {});
    if (active === id) activate(tabs[Math.max(0, i - 1)]?.id ?? "home");
    else drawTabs();
  }

  root.querySelector<HTMLElement>(".web-tabs")!.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>("[data-t]");
    if (t.closest(".x") && tab) return closeTab(tab.dataset.t!);
    if (tab) return activate(tab.dataset.t!);
    const n = t.closest<HTMLElement>("[data-n]")?.dataset.n;
    if (!n || active === "home") return;
    if (n === "window") {
      const id = active;
      closeTab(id);
      invoke("connector_open", { id }).catch((err) => toast(String(err), "err"));
    } else {
      invoke("web_embed_nav", { id: active, action: n }).catch((err) => toast(String(err), "err"));
    }
  });

  /** Open a link (e.g. from an alert): in the matching connector's tab, otherwise in the browser. */
  window.addEventListener("open-url", async (e) => {
    const url = (e as CustomEvent<string>).detail;
    let origin = "";
    try { origin = new URL(url).origin; } catch { return toast("Некорректная ссылка", "err"); }
    const list = await invoke<Connector[]>("connectors_list").catch(() => [] as Connector[]);
    const c = list.find((x) => { try { return new URL(x.url).origin === origin; } catch { return false; } });
    if (!c) {
      invoke("open_external", { url }).catch((err) => toast(String(err), "err"));
      return;
    }
    pendingUrl = { id: c.id, url };
    openTab(c);
  });

  new ResizeObserver(place).observe(slot);
  window.addEventListener("resize", place);
  window.addEventListener("view-shown", (e) => {
    if ((e as CustomEvent).detail === "web") { place(); if (active === "home") refresh(); }
    else invoke("web_embed_hide", { id: null }).catch(() => {});
  });
  window.addEventListener("overlay-open", () => { overlays++; invoke("web_embed_hide", { id: null }).catch(() => {}); });
  window.addEventListener("overlay-close", () => { overlays = Math.max(0, overlays - 1); place(); });

  root.querySelector<HTMLElement>("[data-act=add]")!.onclick = () => openDialog(null);
  // from the alerts view: "add Grafana / Alertmanager / AI analyzer"
  window.addEventListener("add-connector", (e) => {
    window.dispatchEvent(new CustomEvent("show-view", { detail: "web" }));
    activate("home");
    openDialog(null, (e as CustomEvent<string>).detail);
  });
  registerProvider(async () => (await invoke<Connector[]>("connectors_list")).flatMap((c) => [
    { group: KINDS[c.kind]?.label ?? "Веб", title: `Открыть: ${c.name}`, hint: c.url, run: () => openTab(c) },
    { group: KINDS[c.kind]?.label ?? "Веб", title: `Открыть в окне: ${c.name}`, hint: c.url,
      run: () => { invoke("connector_open", { id: c.id }).catch((e) => toast(String(e), "err")); } },
  ]));
  drawTabs();
  refresh().then(async () => {
    // drop remembered tabs whose connectors no longer exist
    const ids = new Set((await invoke<Connector[]>("connectors_list").catch(() => [])).map((c) => c.id));
    tabs = tabs.filter((t) => ids.has(t.id));
    saveTabs();
    drawTabs();
  });
}
