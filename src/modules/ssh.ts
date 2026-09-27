import { helpBtn } from "./help";
import { invoke } from "@tauri-apps/api/core";
import { kpEntries, kpStatus, pickEntry } from "./keepass";
import { registerProvider } from "./palette";
import { ask, esc, toast } from "./ui";

type SshHost = {
  id: string; name: string; group: string; host: string; port: number; user: string;
  identity_file: string; jump: string; auth: string; keepass_entry: string;
};
type ConfigHost = { alias: string; hostname: string; user: string; port: string; identity_file: string; proxy_jump: string };
type SshList = { hosts: SshHost[]; config: ConfigHost[] };
type Spec = { program: string; args: string[]; password_copied: boolean };

const AUTH: Record<string, string> = { key: "ключ / ssh-agent", keepass: "пароль из KeePass", password: "пароль (keyring)", none: "спросит ssh" };

async function connect(title: string, target: { id?: string; alias?: string }) {
  try {
    const spec = await invoke<Spec>("ssh_connect", { id: target.id ?? null, alias: target.alias ?? null });
    window.dispatchEvent(new CustomEvent("open-terminal", { detail: { title, program: spec.program, args: spec.args, keepOpen: true } }));
    if (spec.password_copied) toast("Пароль в буфере на 30 с — вставьте Ctrl+Shift+V");
  } catch (e) { toast(String(e), "err"); }
}

registerProvider(async () => {
  const l = await invoke<SshList>("ssh_list");
  return [
    ...l.hosts.map((h) => ({ group: "SSH", title: `SSH: ${h.name}`, hint: `${h.user ? h.user + "@" : ""}${h.host}`, run: () => connect(`ssh ${h.name}`, { id: h.id }) })),
    ...l.config.map((h) => ({ group: "SSH", title: `SSH: ${h.alias}`, hint: `~/.ssh/config${h.hostname ? " · " + h.hostname : ""}`, run: () => connect(`ssh ${h.alias}`, { alias: h.alias }) })),
  ];
});

export function mountSsh(root: HTMLElement) {
  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h2>SSH</h2>
        <div class="row"><input class="ssh-filter" placeholder="фильтр…" spellcheck="false" /><button class="primary" data-a="add">＋ Хост</button>${helpBtn("ssh")}</div>
      </div>
      <p class="muted">Подключение открывает вкладку терминала. Хосты из ~/.ssh/config подключаются по алиасу со всеми его настройками. Пароль из KeePass/keyring кладётся в буфер на 30 с.</p>
      <div class="ssh-list"></div>
      <dialog class="ssh-dialog">
        <form method="dialog">
          <h3>SSH-хост</h3>
          <div class="grid2">
            <label>Название <input name="name" required placeholder="prod-db-1" /></label>
            <label>Группа <input name="group" placeholder="prod / стенд" /></label>
            <label>Адрес <input name="host" required placeholder="10.0.0.5 или host.example.com" spellcheck="false" /></label>
            <div class="grid2">
              <label>Порт <input name="port" type="number" min="1" max="65535" value="22" /></label>
              <label>Пользователь <input name="user" spellcheck="false" autocomplete="off" /></label>
            </div>
          </div>
          <label>Ключ (-i) <input name="identity_file" list="ssh-keys" spellcheck="false" placeholder="по умолчанию: ssh-agent / ~/.ssh/id_*" /></label>
          <label>Jump-хост (-J) <input name="jump" spellcheck="false" placeholder="user@bastion:22" /></label>
          <label>Аутентификация <select name="auth">${Object.entries(AUTH).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
          <div data-s="keepass" class="kp-bind"><span class="kp-bound muted">запись не выбрана</span><button type="button" data-a="pick">Выбрать запись…</button></div>
          <label data-s="password">Пароль <input name="secret" type="password" autocomplete="new-password" /></label>
          <datalist id="ssh-keys"></datalist>
          <p class="err form-err"></p>
          <div class="actions"><button value="cancel" formnovalidate>Отмена</button><button value="save" class="primary">Сохранить</button></div>
        </form>
      </dialog>
    </div>`;

  const list = root.querySelector<HTMLElement>(".ssh-list")!;
  const filter = root.querySelector<HTMLInputElement>(".ssh-filter")!;
  const dialog = root.querySelector<HTMLDialogElement>("dialog")!;
  const form = dialog.querySelector("form")!;
  const f = (n: string) => form.elements.namedItem(n) as HTMLInputElement & HTMLSelectElement;
  let data: SshList = { hosts: [], config: [] };
  let editing: SshHost | null = null;
  let boundEntry = "";
  let titles = new Map<string, string>();

  const sync = () => {
    const a = f("auth").value;
    form.querySelector<HTMLElement>("[data-s=keepass]")!.hidden = a !== "keepass";
    form.querySelector<HTMLElement>("[data-s=password]")!.hidden = a !== "password";
    f("user").placeholder = a === "keepass" ? "из записи KeePass" : "";
    f("secret").placeholder = editing ? "оставьте пустым, чтобы не менять" : "";
  };
  f("auth").onchange = sync;
  const setBound = (id: string, label?: string) => {
    boundEntry = id;
    form.querySelector(".kp-bound")!.textContent = id ? (label ?? titles.get(id) ?? "запись выбрана") : "запись не выбрана";
  };
  form.querySelector<HTMLElement>("[data-a=pick]")!.onclick = async () => {
    const e = await pickEntry();
    if (e) setBound(e.id, `${e.title}${e.username ? " · " + e.username : ""}`);
  };

  async function open(h: Partial<SshHost> | null, isEdit = false) {
    editing = isEdit ? (h as SshHost) : null;
    form.reset();
    form.querySelector(".form-err")!.textContent = "";
    for (const k of ["name", "group", "host", "user", "identity_file", "jump"] as const) f(k).value = String(h?.[k] ?? "");
    f("port").value = String(h?.port ?? 22);
    f("auth").value = h?.auth ?? "key";
    setBound(h?.keepass_entry ?? "");
    sync();
    const keys = await invoke<string[]>("ssh_keys").catch(() => []);
    form.querySelector("#ssh-keys")!.innerHTML = keys.map((k) => `<option value="${esc(k)}">`).join("");
    dialog.showModal();
  }

  form.addEventListener("submit", async (e) => {
    if ((e.submitter as HTMLButtonElement | null)?.value !== "save") return;
    e.preventDefault();
    const host: SshHost = {
      id: editing?.id ?? crypto.randomUUID(),
      name: f("name").value.trim(), group: f("group").value.trim(), host: f("host").value.trim(),
      port: Number(f("port").value) || 22, user: f("user").value.trim(), identity_file: f("identity_file").value.trim(),
      jump: f("jump").value.trim(), auth: f("auth").value, keepass_entry: f("auth").value === "keepass" ? boundEntry : "",
    };
    try {
      await invoke("ssh_save", { host, secret: f("secret").value || null });
      dialog.close();
      load();
    } catch (err) { form.querySelector(".form-err")!.textContent = String(err); }
  });

  async function load() {
    data = await invoke<SshList>("ssh_list").catch((e) => { toast(String(e), "err"); return { hosts: [], config: [] }; });
    titles = new Map();
    if (data.hosts.some((h) => h.auth === "keepass") && (await kpStatus()).unlocked)
      (await kpEntries().catch(() => [])).forEach((e) => titles.set(e.id, e.title));
    draw();
  }

  function draw() {
    const q = filter.value.trim().toLowerCase();
    const match = (...xs: string[]) => !q || xs.join(" ").toLowerCase().includes(q);
    const groups = new Map<string, SshHost[]>();
    for (const h of data.hosts.filter((h) => match(h.name, h.host, h.group, h.user)).sort((a, b) => a.name.localeCompare(b.name)))
      groups.set(h.group, [...(groups.get(h.group) ?? []), h]);
    const own = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, hs]) => `
      <div class="mt-group">${g ? `<div class="side-head small">${esc(g)}</div>` : ""}
      <table class="res mt-table"><tbody>${hs.map((h) => `
        <tr data-id="${esc(h.id)}">
          <td class="mt-name">${esc(h.name)}</td>
          <td class="mono">${esc(h.user ? h.user + "@" : "")}${esc(h.host)}${h.port !== 22 ? `<span class="muted">:${h.port}</span>` : ""}</td>
          <td class="muted">${h.jump ? `через ${esc(h.jump)} · ` : ""}${h.auth === "keepass" ? `🔑 ${esc(titles.get(h.keepass_entry) ?? "KeePass")}` : esc(AUTH[h.auth] ?? "")}</td>
          <td class="mt-acts">
            <button class="primary" data-a="connect">Подключиться</button>
            <button class="icon" data-a="edit" title="Изменить">✎</button>
            <button class="icon danger" data-a="del" title="Удалить">×</button>
          </td></tr>`).join("")}</tbody></table></div>`).join("");
    const cfg = data.config.filter((h) => match(h.alias, h.hostname, h.user));
    const cfgHtml = cfg.length ? `
      <div class="mt-group"><div class="side-head small">~/.ssh/config</div>
      <table class="res mt-table"><tbody>${cfg.map((h) => `
        <tr data-alias="${esc(h.alias)}">
          <td class="mt-name">${esc(h.alias)}</td>
          <td class="mono">${esc(h.user ? h.user + "@" : "")}${esc(h.hostname || h.alias)}${h.port ? `<span class="muted">:${esc(h.port)}</span>` : ""}</td>
          <td class="muted">${h.proxy_jump ? `через ${esc(h.proxy_jump)} · ` : ""}${h.identity_file ? `ключ ${esc(h.identity_file.split("/").pop())}` : ""}</td>
          <td class="mt-acts">
            <button class="primary" data-a="connect-cfg">Подключиться</button>
            <button class="icon" data-a="copy-cfg" title="Сохранить как профиль OpsDeck (можно привязать пароль из KeePass)">⧉</button>
          </td></tr>`).join("")}</tbody></table></div>` : "";
    list.innerHTML = own + cfgHtml || `<p class="muted">Пока пусто — добавьте хост или заведите его в ~/.ssh/config.</p>`;
  }

  list.onclick = async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    const tr = b?.closest("tr");
    if (!b || !tr) return;
    const h = data.hosts.find((x) => x.id === tr.dataset.id);
    const c = data.config.find((x) => x.alias === tr.dataset.alias);
    switch (b.dataset.a) {
      case "connect": if (h) connect(`ssh ${h.name}`, { id: h.id }); break;
      case "connect-cfg": if (c) connect(`ssh ${c.alias}`, { alias: c.alias }); break;
      case "edit": if (h) open(h, true); break;
      case "copy-cfg":
        if (c) open({ name: c.alias, host: c.hostname || c.alias, user: c.user, port: Number(c.port) || 22,
          identity_file: c.identity_file, jump: c.proxy_jump, auth: "key" }); // ssh -i expands ~ itself
        break;
      case "del":
        if (h && (await ask("Удалить хост", `Удалить «${h.name}» (${h.host})?`, { ok: "Удалить", danger: true })) !== null) {
          await invoke("ssh_delete", { id: h.id });
          load();
        }
    }
  };
  filter.oninput = draw;
  root.querySelector<HTMLElement>("[data-a=add]")!.onclick = () => open(null);
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "ssh") load(); });
  load();
}
