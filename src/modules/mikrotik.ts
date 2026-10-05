import { helpBtn } from "./help";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { kpEntries, kpStatus, pickEntry } from "./keepass";
import { ask, esc, toast } from "./ui";
import { registerProvider } from "./palette";

type Device = {
  id: string; name: string; host: string; group: string; username: string;
  auth: string; keepass_entry: string; winbox_port: number; ssh_port: number;
};

const AUTH: Record<string, string> = { keepass: "из KeePass", password: "пароль (keyring)", none: "без пароля" };

export function mountMikrotik(root: HTMLElement) {
  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h2>MikroTik</h2>
        <div class="row"><input class="mt-filter" placeholder="фильтр…" spellcheck="false" /><button class="primary" data-a="add">${icon("plus", 16)} Устройство</button>${helpBtn("winbox")}</div>
      </div>
      <p class="muted">WinBox запускается с логином и паролем из KeePass или keyring. SSH открывается вкладкой терминала, а пароль кладётся в буфер на 30 с.</p>
      <div class="mt-list"></div>
      <dialog class="mt-dialog">
        <form method="dialog">
          <h3>Устройство</h3>
          <div class="grid2">
            <label>Название <input name="name" required placeholder="core-router" /></label>
            <label>Группа <input name="group" placeholder="офис / ДЦ" /></label>
            <label>Адрес <input name="host" required placeholder="192.168.88.1" spellcheck="false" /></label>
            <div class="grid2">
              <label>WinBox порт <input name="winbox_port" type="number" min="1" max="65535" value="8291" /></label>
              <label>SSH порт <input name="ssh_port" type="number" min="1" max="65535" value="22" /></label>
            </div>
          </div>
          <label>Учётные данные <select name="auth">${Object.entries(AUTH).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
          <div data-s="keepass" class="kp-bind"><span class="kp-bound muted">запись не выбрана</span><button type="button" data-a="pick">Выбрать запись…</button></div>
          <label data-s="user">Логин <input name="username" autocomplete="off" spellcheck="false" placeholder="" /></label>
          <label data-s="password">Пароль <input name="secret" type="password" autocomplete="new-password" /></label>
          <p class="err form-err"></p>
          <div class="actions"><button value="cancel" formnovalidate>Отмена</button><button value="save" class="primary">Сохранить</button></div>
        </form>
      </dialog>
    </div>`;

  const list = root.querySelector<HTMLElement>(".mt-list")!;
  const filter = root.querySelector<HTMLInputElement>(".mt-filter")!;
  const dialog = root.querySelector<HTMLDialogElement>("dialog")!;
  const form = dialog.querySelector("form")!;
  const f = (n: string) => form.elements.namedItem(n) as HTMLInputElement & HTMLSelectElement;
  let devices: Device[] = [];
  let editing: Device | null = null;
  let boundEntry = "";
  let titles = new Map<string, string>();

  const sync = () => {
    const a = f("auth").value;
    form.querySelector<HTMLElement>("[data-s=keepass]")!.hidden = a !== "keepass";
    form.querySelector<HTMLElement>("[data-s=password]")!.hidden = a !== "password";
    f("username").placeholder = a === "keepass" ? "из записи KeePass" : "admin";
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

  const open = (d: Device | null) => {
    editing = d;
    form.reset();
    form.querySelector(".form-err")!.textContent = "";
    for (const k of ["name", "group", "host", "username"] as const) f(k).value = d?.[k] ?? "";
    f("winbox_port").value = String(d?.winbox_port ?? 8291);
    f("ssh_port").value = String(d?.ssh_port ?? 22);
    f("auth").value = d?.auth ?? "keepass";
    setBound(d?.keepass_entry ?? "");
    sync();
    dialog.showModal();
  };

  form.addEventListener("submit", async (e) => {
    if ((e.submitter as HTMLButtonElement | null)?.value !== "save") return;
    e.preventDefault();
    const device: Device = {
      id: editing?.id ?? crypto.randomUUID(),
      name: f("name").value.trim(), group: f("group").value.trim(), host: f("host").value.trim(),
      username: f("username").value.trim(), auth: f("auth").value, keepass_entry: f("auth").value === "keepass" ? boundEntry : "",
      winbox_port: Number(f("winbox_port").value) || 8291, ssh_port: Number(f("ssh_port").value) || 22,
    };
    try {
      await invoke("mt_save", { device, secret: f("secret").value || null });
      dialog.close();
      load();
    } catch (err) { form.querySelector(".form-err")!.textContent = String(err); }
  });

  async function load() {
    devices = await invoke<Device[]>("mt_list").catch((e) => { toast(String(e), "err"); return []; });
    // KeePass entry titles are only known while the db is unlocked
    titles = new Map();
    if ((await kpStatus()).unlocked) (await kpEntries().catch(() => [])).forEach((e) => titles.set(e.id, `${e.title}${e.username ? " · " + e.username : ""}`));
    draw();
  }

  function draw() {
    const q = filter.value.trim().toLowerCase();
    const shown = devices.filter((d) => !q || [d.name, d.host, d.group].join(" ").toLowerCase().includes(q));
    if (!devices.length) { list.innerHTML = `<p class="muted">Пока пусто — добавьте первый роутер.</p>`; return; }
    const groups = new Map<string, Device[]>();
    for (const d of shown.sort((a, b) => a.name.localeCompare(b.name))) groups.set(d.group, [...(groups.get(d.group) ?? []), d]);
    list.innerHTML = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, ds]) => `
      <div class="mt-group">${g ? `<div class="side-head small">${esc(g)}</div>` : ""}
      <table class="res mt-table"><tbody>${ds.map((d) => `
        <tr data-id="${esc(d.id)}">
          <td class="mt-name">${esc(d.name)}</td>
          <td>${esc(d.host)}${d.winbox_port !== 8291 ? `<span class="muted">:${d.winbox_port}</span>` : ""}</td>
          <td class="muted">${esc(d.username || "")} ${d.auth === "keepass" ? `${icon("key", 14)} ${esc(titles.get(d.keepass_entry) ?? "KeePass")}` : d.auth === "password" ? "· keyring" : ""}</td>
          <td class="mt-acts">
            <button class="primary" data-a="winbox">WinBox</button>
            <button data-a="ssh">SSH</button>
            <button class="ghost" data-a="ping">ping</button>
            <button class="icon" data-a="edit" title="Изменить">${icon("edit", 14)}</button>
            <button class="icon danger" data-a="del" title="Удалить">${icon("trash", 14)}</button>
          </td></tr>`).join("")}</tbody></table></div>`).join("");
  }

  list.onclick = async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    const tr = b?.closest("tr");
    const d = tr && devices.find((x) => x.id === tr.dataset.id);
    if (!b || !d) return;
    switch (b.dataset.a) {
      case "winbox":
        invoke("mt_winbox", { id: d.id }).then(() => toast(`WinBox → ${d.name}`), (err) => toast(String(err), "err"));
        break;
      case "ssh":
        try {
          const spec = await invoke<{ program: string; args: string[]; password_copied: boolean }>("mt_ssh", { id: d.id });
          window.dispatchEvent(new CustomEvent("open-terminal", { detail: { title: `ssh ${d.name}`, program: spec.program, args: spec.args, keepOpen: true } }));
          if (spec.password_copied) toast("Пароль в буфере на 30 с — вставьте Ctrl+Shift+V");
        } catch (err) { toast(String(err), "err"); }
        break;
      case "ping":
        window.dispatchEvent(new CustomEvent("open-terminal", { detail: { title: `ping ${d.name}`, program: "ping", args: [d.host], keepOpen: true } }));
        break;
      case "edit":
        open(d);
        break;
      case "del":
        if ((await ask("Удалить устройство", `Удалить «${d.name}» (${d.host})?`, { ok: "Удалить", danger: true })) !== null) {
          await invoke("mt_delete", { id: d.id });
          load();
        }
    }
  };

  filter.oninput = draw;
  registerProvider(async () => (await invoke<Device[]>("mt_list")).flatMap((d) => [
    { group: "MikroTik", title: `WinBox: ${d.name}`, hint: d.host, run: () => { invoke("mt_winbox", { id: d.id }).catch((e) => toast(String(e), "err")); } },
    { group: "MikroTik", title: `SSH: ${d.name}`, hint: d.host, run: () => { list.querySelector<HTMLElement>(`tr[data-id="${d.id}"] [data-a=ssh]`)?.click() ?? toast("Откройте раздел MikroTik", "err"); } },
  ]));
  root.querySelector<HTMLElement>("[data-a=add]")!.onclick = () => open(null);
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "winbox") load(); });
  load();
}
