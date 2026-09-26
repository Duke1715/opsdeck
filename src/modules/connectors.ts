import { invoke } from "@tauri-apps/api/core";
import { pickEntry } from "./keepass";
import { ask, esc, toast } from "./ui";
import { registerProvider } from "./palette";

type Connector = { id: string; kind: string; name: string; url: string; username: string; auth: string; keepass_entry?: string };

const KINDS: Record<string, { label: string; auth: string[]; hint: string }> = {
  grafana: { label: "Grafana", auth: ["keepass", "password", "none"], hint: "Логин/пароль локального пользователя. SSO/OAuth — вход вручную, сессия сохранится." },
  argocd: { label: "ArgoCD", auth: ["keepass", "password", "token"], hint: "admin/пароль или API-токен (argocd account generate-token)." },
  gitlab: { label: "GitLab", auth: ["keepass", "password", "none"], hint: "Логин/пароль заполняются в форму входа. 2FA вводится руками." },
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
          <label>Название <input name="name" required placeholder="prod grafana" /></label>
          <label>URL <input name="url" type="url" required placeholder="https://grafana.example.com" /></label>
          <label>Авторизация <select name="auth"></select></label>
          <div data-a="keepass" class="kp-bind"><span class="kp-bound muted">запись не выбрана</span><button type="button" data-a="pick">Выбрать запись…</button></div>
          <label data-a="user">Логин <input name="username" autocomplete="off" /></label>
          <label data-a="secret"><span class="secret-label">Пароль</span> <input name="secret" type="password" autocomplete="new-password" placeholder="" /></label>
          <p class="muted hint"></p>
          <p class="err form-err"></p>
          <div class="actions">
            <button value="cancel" formnovalidate>Отмена</button>
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
  };
  f("kind").onchange = syncForm;
  f("auth").onchange = syncForm;

  const openDialog = (c: Connector | null) => {
    editing = c;
    form.reset();
    form.querySelector<HTMLElement>(".form-err")!.textContent = "";
    f("kind").value = c?.kind ?? "grafana";
    f("name").value = c?.name ?? "";
    f("url").value = c?.url ?? "";
    f("username").value = c?.username ?? "";
    setBound(c?.keepass_entry ?? "");
    syncForm();
    if (c) { f("auth").value = c.auth; syncForm(); }
    dialog.showModal();
  };

  form.addEventListener("submit", async (e) => {
    if ((e.submitter as HTMLButtonElement | null)?.value !== "save") return;
    e.preventDefault();
    const connector: Connector = {
      id: editing?.id ?? crypto.randomUUID(),
      kind: f("kind").value, name: f("name").value.trim(), url: f("url").value.trim(),
      username: f("username").value.trim(), auth: f("auth").value,
      keepass_entry: f("auth").value === "keepass" ? boundEntry : "",
    };
    try {
      await invoke("connector_save", { connector, secret: f("secret").value || null });
      // settings changed: the embedded panel is recreated with them on next show
      if (editing) invoke("web_embed_close", { id: connector.id }).catch(() => {});
      dialog.close();
      refresh();
    } catch (err) {
      form.querySelector<HTMLElement>(".form-err")!.textContent = String(err);
    }
  });

  async function refresh() {
    const list = await invoke<Connector[]>("connectors_list").catch((e) => {
      cards.textContent = String(e);
      return [];
    });
    cards.innerHTML = list.length ? "" : `<p class="muted">Пока пусто — добавьте Grafana, ArgoCD или GitLab.</p>`;
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
          <button class="ghost" data-act="edit">Изменить</button>
          <button class="ghost danger" data-act="del">Удалить</button>
        </div>`;
      card.querySelector(".card-kind")!.textContent = KINDS[c.kind]?.label ?? c.kind;
      card.querySelector(".card-name")!.textContent = c.name;
      card.querySelector(".card-url")!.textContent = c.url;
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
      cards.appendChild(card);
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
      await invoke("web_embed_show", { id: active, rect: { x: r.left, y: r.top, w: r.width, h: r.height } })
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

  new ResizeObserver(place).observe(slot);
  window.addEventListener("resize", place);
  window.addEventListener("view-shown", (e) => {
    if ((e as CustomEvent).detail === "web") { place(); if (active === "home") refresh(); }
    else invoke("web_embed_hide", { id: null }).catch(() => {});
  });
  window.addEventListener("overlay-open", () => { overlays++; invoke("web_embed_hide", { id: null }).catch(() => {}); });
  window.addEventListener("overlay-close", () => { overlays = Math.max(0, overlays - 1); place(); });

  root.querySelector<HTMLElement>("[data-act=add]")!.onclick = () => openDialog(null);
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
