import { invoke } from "@tauri-apps/api/core";
import { esc, toast } from "./ui";
import { mountSnippets } from "./snippets";

type Settings = {
  keepass_path: string; keepass_keyfile: string; keepass_lock_minutes: number;
  obsidian_vault: string; winbox_path: string; k8s_include_system: boolean;
};
type Detected = { keepass: string[]; obsidian: string[]; winbox: string[] };

export function mountSettings(root: HTMLElement) {
  root.innerHTML = `
    <div class="page settings">
      <h2>Настройки</h2>
      <form>
        <fieldset><legend>KeePass</legend>
          <label>База .kdbx <input name="keepass_path" list="dl-kp" spellcheck="false" /></label>
          <label>Ключевой файл (необязательно) <input name="keepass_keyfile" spellcheck="false" /></label>
          <label>Автоблокировка, минут без действий (0 — выключить) <input name="keepass_lock_minutes" type="number" min="0" max="1440" /></label>
        </fieldset>
        <fieldset><legend>Заметки</legend>
          <label>Папка с заметками (Obsidian vault или любая папка с .md) <input name="obsidian_vault" list="dl-ob" spellcheck="false" /></label>
        </fieldset>
        <fieldset><legend>Kubernetes</legend>
          <label class="check"><input type="checkbox" name="k8s_include_system" /> Показывать и контексты из общего ~/.kube/config</label>
          <p class="muted hint">Выключено: OpsDeck работает только со своими копиями (＋ в разделе Kubernetes → «Добавить из ~/.kube/config»), и kubectl во вкладках OpsDeck видит только их. Ваш ~/.kube/config не меняется.</p>
        </fieldset>
        <fieldset><legend>MikroTik</legend>
          <label>WinBox <input name="winbox_path" list="dl-wb" spellcheck="false" /></label>
        </fieldset>
        <datalist id="dl-kp"></datalist><datalist id="dl-ob"></datalist><datalist id="dl-wb"></datalist>
        <div class="row"><button class="primary" type="submit">Сохранить</button><span class="muted detect-state"></span></div>
      </form>
      <fieldset class="sn-field"><legend>Сниппеты</legend><div class="sn-root"></div></fieldset>
      <p class="muted">Конфиги: ~/.config/opsdeck/ · пароли коннекторов и роутеров — в системном keyring.</p>
    </div>`;

  const form = root.querySelector("form")!;
  mountSnippets(root.querySelector<HTMLElement>(".sn-root")!);
  const f = (n: keyof Settings) => form.elements.namedItem(n) as HTMLInputElement;

  async function load() {
    const s = await invoke<Settings>("settings_get");
    for (const k of Object.keys(s) as (keyof Settings)[]) {
      if (typeof s[k] === "boolean") f(k).checked = s[k] as boolean;
      else f(k).value = String(s[k] ?? "");
    }
    root.querySelector(".detect-state")!.textContent = "ищу варианты в домашней папке…";
    const d = await invoke<Detected>("settings_detect").catch(() => null);
    root.querySelector(".detect-state")!.textContent = "";
    if (!d) return;
    const fill = (id: string, xs: string[]) => (root.querySelector(`#${id}`)!.innerHTML = xs.map((x) => `<option value="${esc(x)}">`).join(""));
    fill("dl-kp", d.keepass);
    fill("dl-ob", d.obsidian);
    fill("dl-wb", d.winbox);
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const settings: Settings = {
      keepass_path: f("keepass_path").value.trim(), keepass_keyfile: f("keepass_keyfile").value.trim(),
      keepass_lock_minutes: Number(f("keepass_lock_minutes").value) || 0,
      obsidian_vault: f("obsidian_vault").value.trim(), winbox_path: f("winbox_path").value.trim(),
      k8s_include_system: f("k8s_include_system").checked,
    };
    try {
      await invoke("settings_set", { settings });
      toast("Настройки сохранены");
      window.dispatchEvent(new Event("settings-changed"));
    } catch (err) { toast(String(err), "err"); }
  };

  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "settings") load(); });
}
