import { invoke } from "@tauri-apps/api/core";
import { pickEntry } from "./keepass";
import { ask, toast } from "./ui";

type Connector = { id: string; kind: string; name: string; url: string; username: string; auth: string; keepass_entry?: string };

const KINDS: Record<string, { label: string; auth: string[]; hint: string }> = {
  grafana: { label: "Grafana", auth: ["keepass", "password", "none"], hint: "Логин/пароль локального пользователя. SSO/OAuth — вход вручную, сессия сохранится." },
  argocd: { label: "ArgoCD", auth: ["keepass", "password", "token"], hint: "admin/пароль или API-токен (argocd account generate-token)." },
  gitlab: { label: "GitLab", auth: ["keepass", "password", "none"], hint: "Логин/пароль заполняются в форму входа. 2FA вводится руками." },
  generic: { label: "Другое (URL)", auth: ["none"], hint: "Просто открыть веб-интерфейс в отдельном окне." },
};
const AUTH_LABEL: Record<string, string> = { keepass: "из KeePass", password: "логин/пароль", token: "токен", none: "без автологина" };

export function mountConnectors(root: HTMLElement) {
  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h2>Веб-панели</h2>
        <button class="primary" data-act="add">＋ Добавить</button>
      </div>
      <p class="muted">Grafana, ArgoCD, GitLab и любые другие веб-интерфейсы открываются в отдельном окне с автологином. Секреты хранятся в системном keyring.</p>
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
          <button class="ghost" data-act="edit">Изменить</button>
          <button class="ghost danger" data-act="del">Удалить</button>
        </div>`;
      card.querySelector(".card-kind")!.textContent = KINDS[c.kind]?.label ?? c.kind;
      card.querySelector(".card-name")!.textContent = c.name;
      card.querySelector(".card-url")!.textContent = c.url;
      card.querySelector<HTMLElement>("[data-act=open]")!.onclick = () =>
        invoke("connector_open", { id: c.id }).catch((e) => toast(String(e), "err"));
      card.querySelector<HTMLElement>("[data-act=edit]")!.onclick = () => openDialog(c);
      card.querySelector<HTMLElement>("[data-act=del]")!.onclick = async () => {
        if ((await ask("Удалить коннектор", `Удалить «${c.name}»? Сохранённый секрет тоже будет удалён.`, { ok: "Удалить", danger: true })) !== null) {
          await invoke("connector_delete", { id: c.id });
          refresh();
        }
      };
      cards.appendChild(card);
    }
  }

  root.querySelector<HTMLElement>("[data-act=add]")!.onclick = () => openDialog(null);
  refresh();
}
