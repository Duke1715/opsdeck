import { helpBtn } from "./help";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { age } from "./k8s-details";
import { registerProvider } from "./palette";
import { ask, esc, toast } from "./ui";

type Alert = {
  kind: string; links: { title: string; url: string }[];
  fingerprint: string; status: string; silenced: boolean; source: string; name: string; severity: string;
  summary: string; description: string; labels: Record<string, string>; annotations: Record<string, string>;
  starts_at: string; ends_at: string; generator_url: string; silence_url: string; dashboard_url: string;
  panel_url: string; value: string; received_at: string; acked: boolean;
};
type View = { current: Alert[]; history: Alert[]; firing: number };
type Config = { ingest_enabled: boolean; ingest_port: number; poll_enabled: boolean; poll_seconds: number; notify: boolean; notify_resolved: boolean };

const SEV_ORDER = ["critical", "high", "error", "warning", "medium", "info", "low", ""];
const sevRank = (s: string) => { const i = SEV_ORDER.findIndex((x) => s.toLowerCase().includes(x)); return i < 0 ? SEV_ORDER.length : i; };
const sevClass = (s: string) => (/crit|high|error|p1/i.test(s) ? "crit" : /warn|medium|p2/i.test(s) ? "warn" : "info");
// labels that are noise in the card (shown elsewhere or internal)
const HIDDEN_LABELS = new Set(["alertname", "severity", "__alert_rule_uid__", "grafana_folder", "__alert_rule_namespace_uid__"]);

export function mountAlerts(root: HTMLElement) {
  root.innerHTML = `
    <div class="page alerts">
      <div class="page-head">
        <h2>Алерты <span class="muted small-note al-summary"></span></h2>
        <div class="row">
          <input class="al-filter" placeholder="фильтр…" spellcheck="false" />
          <button class="ghost" data-a="poll" title="Опросить Grafana сейчас">↻ Опросить</button>
          <button class="ghost" data-a="settings">⚙</button>
          ${helpBtn("alerts")}
        </div>
      </div>
      <div class="al-errors err" hidden></div>
      <form class="al-settings" hidden>
        <p class="muted">Источники заводятся в «Веб-панелях» (◎): Grafana (логин/пароль, токен service account или KeePass), Prometheus Alertmanager и «AI / анализатор». OpsDeck сам их опрашивает — извне на этот компьютер ничего не приходит, IP и NAT не важны. Локальные анализаторы могут присылать находки на 127.0.0.1 (подсказка — в настройках AI-коннектора).</p>
        <div class="row wrap">
          <label class="check"><input type="checkbox" name="poll_enabled" /> Опрашивать</label>
          <label>каждые <input type="number" name="poll_seconds" min="15" max="3600" /> с</label>
          <label class="check"><input type="checkbox" name="notify" /> Уведомления на рабочем столе</label>
          <label class="check"><input type="checkbox" name="notify_resolved" /> …и о восстановлении</label>
          <label class="check"><input type="checkbox" name="ingest_enabled" /> Приём от локальных анализаторов на 127.0.0.1:</label>
          <input type="number" name="ingest_port" min="1024" max="65535" />
          <button class="primary">Сохранить</button>
        </div>
      </form>
      <div class="al-current"></div>
      <details class="al-history-wrap" open>
        <summary class="side-head small">История <button class="ghost al-clear" type="button" data-a="clear-history">очистить</button></summary>
        <table class="res al-history"><thead><tr><th>Когда</th><th>Статус</th><th>Алерт</th><th>Severity</th><th>Описание</th><th>Источник</th></tr></thead><tbody></tbody></table>
      </details>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const current = $(".al-current"), hist = $(".al-history tbody"), filter = $<HTMLInputElement>(".al-filter");
  const form = $<HTMLFormElement>(".al-settings"), errors = $(".al-errors");
  const f = (n: keyof Config) => form.elements.namedItem(n) as HTMLInputElement;
  let data: View = { current: [], history: [], firing: 0 };

  const match = (a: Alert) => {
    const q = filter.value.trim().toLowerCase();
    return !q || [a.name, a.summary, a.description, a.source, a.severity, ...Object.entries(a.labels).map(([k, v]) => `${k}=${v}`)]
      .join(" ").toLowerCase().includes(q);
  };

  function card(a: Alert) {
    const labels = Object.entries(a.labels).filter(([k]) => !HIDDEN_LABELS.has(k));
    const links = [
      a.panel_url && ["Панель", a.panel_url], a.dashboard_url && ["Дашборд", a.dashboard_url],
      a.generator_url && ["Правило", a.generator_url], a.silence_url && ["Silence", a.silence_url],
      ...(a.links ?? []).map((l) => [l.title || "Ссылка", l.url]),
    ].filter(Boolean) as [string, string][];
    const ai = a.kind === "ai";
    const longDesc = a.description.length > 400;
    return `<div class="al-card sev-${sevClass(a.severity)} ${a.acked ? "acked" : ""} ${a.silenced ? "silenced" : ""}" data-fp="${esc(a.fingerprint)}">
      <div class="al-head">
        <span class="al-sev">${esc(a.severity || "—")}</span>
        ${ai ? `<span class="badge ai" title="Находка AI-анализатора">🤖 AI</span>` : ""}
        <strong class="al-name">${esc(a.name)}</strong>
        ${a.silenced ? `<span class="badge">silenced</span>` : ""}${a.acked ? `<span class="badge">просмотрен</span>` : ""}
        <span class="spacer"></span>
        <span class="muted" title="${esc(new Date(a.starts_at).toLocaleString())}">${esc(age(a.starts_at))} · ${esc(a.source)}</span>
      </div>
      ${a.summary ? `<div class="al-summary-text">${esc(a.summary)}</div>` : ""}
      ${a.description && a.description !== a.summary ? (longDesc
        ? `<details class="al-desc"><summary class="muted">${esc(a.description.slice(0, 200))}…</summary><div class="muted">${esc(a.description)}</div></details>`
        : `<div class="muted al-desc">${esc(a.description)}</div>`) : ""}
      ${a.value ? `<div class="mono muted al-value">${esc(a.value)}</div>` : ""}
      ${labels.length ? `<div class="chips">${labels.map(([k, v]) => `<span class="chip">${esc(k)}=${esc(v)}</span>`).join("")}</div>` : ""}
      <div class="al-actions">
        ${links.map(([t, u]) => `<button class="ghost" data-url="${esc(u)}">${esc(t)} ↗</button>`).join("")}
        <span class="spacer"></span>
        <button class="ghost" data-a="ai">⇢ AI</button>
        <button class="ghost" data-a="ack">${a.acked ? "Вернуть" : "✓ Просмотрен"}</button>
        ${ai ? `<button class="ghost" data-a="resolve" title="Убрать в историю">Закрыть</button>` : ""}
      </div>
    </div>`;
  }

  function draw() {
    const cur = data.current.filter(match).sort((a, b) =>
      Number(a.acked || a.silenced) - Number(b.acked || b.silenced) || sevRank(a.severity) - sevRank(b.severity) || b.starts_at.localeCompare(a.starts_at));
    current.innerHTML = cur.length ? cur.map(card).join("")
      : !sources.length ? onboarding()
      : `<div class="al-empty">${data.current.length ? "Ничего не подходит под фильтр" : `✓ Горящих алертов нет · источники: ${esc(sources.join(", "))}`}</div>`;
    const acked = data.current.filter((a) => a.acked || a.silenced).length;
    $(".al-summary").textContent = `горит ${data.firing}${acked ? ` · просмотрено/заглушено ${acked}` : ""}`;
    hist.innerHTML = data.history.filter(match).slice(0, 300).map((a) => `<tr>
      <td title="${esc(new Date(a.received_at).toLocaleString())}">${esc(age(a.received_at))}</td>
      <td class="${a.status === "resolved" ? "ok" : "bad"}">${a.status === "resolved" ? "resolved" : "firing"}</td>
      <td>${esc(a.name)}</td><td>${esc(a.severity)}</td><td class="wrap">${esc(a.summary || a.description)}</td><td class="muted">${esc(a.source)}</td></tr>`).join("")
      || `<tr><td class="muted" colspan="6">Пока пусто</td></tr>`;
  }

  let sources: string[] = [];

  /** No sources yet: how to connect, with buttons that open the right connector dialog. */
  function onboarding() {
    return `<div class="al-onboard">
      <h3>Откуда брать алерты</h3>
      <p class="muted">OpsDeck сам опрашивает источники — в Grafana/Alertmanager ничего настраивать не нужно, на этот компьютер ничего не присылается.</p>
      <ol>
        <li><b>Grafana</b>: в Grafana создайте токен — Administration → Users and access → Service accounts → Add service account (роль Viewer) → Add service account token. Затем здесь «＋ Grafana», авторизация «токен», «Сохранить и проверить».</li>
        <li><b>Prometheus Alertmanager</b>: «＋ Alertmanager», URL вида http://alertmanager:9093.</li>
        <li><b>Свой AI-анализатор</b>: «＋ AI-анализатор» — в карточке будет адрес, токен и пример curl.</li>
      </ol>
      <div class="row">
        <button class="primary" data-add="grafana">＋ Grafana</button>
        <button data-add="alertmanager">＋ Alertmanager</button>
        <button data-add="ai">＋ AI-анализатор</button>
      </div>
    </div>`;
  }

  async function load() {
    sources = await invoke<string[]>("alerts_sources").catch(() => sources);
    data = await invoke<View>("alerts_get", { historyLimit: 300 }).catch(() => data);
    draw();
  }

  async function loadConfig() {
    const c = await invoke<Config>("alerts_config_get");
    f("poll_enabled").checked = c.poll_enabled;
    f("poll_seconds").value = String(c.poll_seconds);
    f("notify").checked = c.notify;
    f("notify_resolved").checked = c.notify_resolved;
    f("ingest_enabled").checked = c.ingest_enabled;
    f("ingest_port").value = String(c.ingest_port);
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const config: Config = {
      poll_enabled: f("poll_enabled").checked, poll_seconds: Math.max(15, Number(f("poll_seconds").value) || 60),
      notify: f("notify").checked, notify_resolved: f("notify_resolved").checked,
      ingest_enabled: f("ingest_enabled").checked, ingest_port: Number(f("ingest_port").value) || 9095,
    };
    await invoke("alerts_config_set", { config }).then(() => toast("Сохранено"), (err) => toast(String(err), "err"));
  };

  root.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const add = t.closest<HTMLElement>("[data-add]")?.dataset.add;
    if (add) return window.dispatchEvent(new CustomEvent("add-connector", { detail: add }));
    const url = t.closest<HTMLElement>("[data-url]")?.dataset.url;
    if (url) return window.dispatchEvent(new CustomEvent("open-url", { detail: url }));
    const act = t.closest<HTMLElement>("[data-a]")?.dataset.a;
    const fp = t.closest<HTMLElement>("[data-fp]")?.dataset.fp;
    const a = data.current.find((x) => x.fingerprint === fp);
    if (act === "settings") { form.hidden = !form.hidden; if (!form.hidden) loadConfig(); }
    if (act === "poll") {
      const errs = await invoke<string[]>("alerts_poll_now");
      showErrors(errs);
      if (!errs.length) toast("Опрошено");
      load();
    }
    if (act === "clear-history" && (await ask("История алертов", "Очистить историю?", { ok: "Очистить", danger: true })) !== null) {
      await invoke("alerts_clear", { current: false, history: true });
      load();
    }
    if (act === "resolve" && a) { await invoke("alerts_resolve", { fingerprint: a.fingerprint }); load(); }
    if (act === "ack" && a) { await invoke("alerts_ack", { fingerprint: a.fingerprint, acked: !a.acked }); load(); }
    if (act === "ai" && a) {
      window.dispatchEvent(new CustomEvent("send-to-ai", { detail:
        `${a.kind === "ai" ? "Находка AI-анализатора" : "Алерт"} (${a.source}): ${a.name}, severity ${a.severity || "—"}, горит с ${new Date(a.starts_at).toLocaleString()}.\n` +
        `${a.summary}\n${a.description}\n${a.value ? `Значения: ${a.value}\n` : ""}Метки: ${Object.entries(a.labels).map(([k, v]) => `${k}=${v}`).join(", ")}\n` +
        `Что это может значить и что проверить в первую очередь?` }));
    }
  });

  function showErrors(errs: string[]) {
    errors.hidden = !errs.length;
    errors.textContent = errs.length ? `Не удалось опросить: ${errs.join("; ")}` : "";
  }

  filter.oninput = draw;
  listen("alerts-changed", load);
  listen<string[]>("alerts-poll", (e) => showErrors(e.payload));
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "alerts") load(); });
  registerProvider(() => data.current.map((a) => ({
    group: "Алерт", title: a.name, hint: `${a.severity} · ${a.source}`,
    run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "alerts" })); filter.value = a.name; draw(); },
  })));
  // settings open by default until there is anything to show
  invoke<Config>("alerts_config_get").then((c) => { if (!c.poll_enabled) { form.hidden = false; loadConfig(); } });
  load();
}
