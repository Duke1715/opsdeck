import { helpBtn } from "./help";
import { invoke } from "@tauri-apps/api/core";
import { esc, toast } from "./ui";
import { mountSnippets } from "./snippets";
import { mountUpdates } from "./updates";
import { hlPrefs, setHlPrefs } from "./highlight";

type Settings = {
  keepass_path: string; keepass_keyfile: string; keepass_lock_minutes: number;
  obsidian_vault: string; winbox_path: string; k8s_include_system: boolean; update_auto_check: boolean;
};
type Detected = { keepass: string[]; obsidian: string[]; winbox: string[] };

export function mountSettings(root: HTMLElement) {
  root.innerHTML = `
    <div class="page settings">
      <h2>Настройки ${helpBtn("settings")}</h2>
      <form>
        <fieldset><legend>KeePass</legend>
          <label>База .kdbx <input name="keepass_path" list="dl-kp" spellcheck="false" /></label>
          <label>Ключевой файл (необязательно) <input name="keepass_keyfile" spellcheck="false" /></label>
          <label>Автоблокировка, минут без действий (0 — выключить) <input name="keepass_lock_minutes" type="number" min="0" max="1440" /></label>
        </fieldset>
        <fieldset class="hl-field"><legend>Терминал</legend>
          <label class="check"><input type="checkbox" data-hl="input" /> Подсветка команды при наборе (как в fish: несуществующая команда — красным)</label>
          <label class="check"><input type="checkbox" data-hl="output" /> Подсветка вывода: ERROR/WARN, статусы подов, IP, ссылки, время</label>
          <p class="muted hint">Применяется сразу. Подсветка ввода работает в локальных вкладках (нужна интеграция с bash/zsh). Вывод, который программа уже раскрасила сама, и полноэкранные программы (vim, htop, less) не трогаются.</p>
        </fieldset>
        <fieldset><legend>Заметки</legend>
          <label>Папка с заметками (Obsidian vault или любая папка с .md) <input name="obsidian_vault" list="dl-ob" spellcheck="false" /></label>
        </fieldset>
        <fieldset><legend>Kubernetes</legend>
          <label class="check"><input type="checkbox" name="k8s_include_system" /> Показывать и контексты из общего ~/.kube/config</label>
          <p class="muted hint">Выключено: OpsDeck работает только со своими копиями (＋ в разделе Kubernetes → «Добавить из ~/.kube/config»), и kubectl во вкладках OpsDeck видит только их. Ваш ~/.kube/config не меняется.</p>
        </fieldset>
        <fieldset><legend>Обновления</legend>
          <div class="upd-root"></div>
          <label class="check"><input type="checkbox" name="update_auto_check" /> Проверять при запуске</label>
          <p class="muted hint">Новые версии берутся из GitHub Releases проекта; каждое обновление подписано, и OpsDeck не установит файл с неверной подписью.</p>
        </fieldset>
        <fieldset><legend>MikroTik</legend>
          <label>WinBox <input name="winbox_path" list="dl-wb" spellcheck="false" /></label>
        </fieldset>
        <datalist id="dl-kp"></datalist><datalist id="dl-ob"></datalist><datalist id="dl-wb"></datalist>
        <div class="row"><button class="primary" type="submit">Сохранить</button><span class="muted detect-state"></span></div>
      </form>
      <fieldset class="log-field"><legend>Журнал</legend>
        <p class="muted hint">Ошибки, зависания интерфейса (с командой, которая в этот момент выполнялась), падения и медленные операции пишутся в файл: <code class="log-path">…</code></p>
        <div class="row"><button type="button" class="ghost" data-log="problems">Показать ошибки и зависания</button><button type="button" class="ghost" data-log="all">Весь журнал (хвост)</button><button type="button" class="ghost" data-log="open">Открыть папку</button></div>
        <pre class="log-view" hidden></pre>
      </fieldset>
      <fieldset class="sn-field"><legend>Сниппеты</legend><div class="sn-root"></div></fieldset>
      <p class="muted">Конфиги: ~/.config/opsdeck/ · пароли коннекторов и роутеров — в системном keyring.</p>
    </div>`;

  const form = root.querySelector("form")!;
  mountSnippets(root.querySelector<HTMLElement>(".sn-root")!);
  mountUpdates(root.querySelector<HTMLElement>(".upd-root")!);
  const hlBoxes = root.querySelectorAll<HTMLInputElement>("[data-hl]");
  const syncHl = () => { const p = hlPrefs(); hlBoxes.forEach((b) => (b.checked = p[b.dataset.hl as "input" | "output"])); };
  hlBoxes.forEach((b) => (b.onchange = () => setHlPrefs({ [b.dataset.hl!]: b.checked })));
  window.addEventListener("term-highlight", syncHl);
  syncHl();
  invoke<string>("logs_path").then((p) => (root.querySelector(".log-path")!.textContent = p)).catch(() => {});
  root.querySelector<HTMLElement>(".log-field")!.addEventListener("click", async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-log]")?.dataset.log;
    if (!act) return;
    if (act === "open") return void invoke("logs_open").catch((err) => toast(String(err), "err"));
    const view = root.querySelector<HTMLElement>(".log-view")!;
    view.hidden = false;
    view.textContent = "загрузка…";
    const text = await invoke<string>("logs_tail", { lines: 300, onlyProblems: act === "problems" }).catch((err) => String(err));
    view.textContent = text || (act === "problems" ? "Проблем не записано ✓" : "Журнал пуст");
    view.scrollTop = view.scrollHeight;
  });
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
      update_auto_check: f("update_auto_check").checked,
    };
    try {
      await invoke("settings_set", { settings });
      toast("Настройки сохранены");
      window.dispatchEvent(new Event("settings-changed"));
    } catch (err) { toast(String(err), "err"); }
  };

  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "settings") load(); });
}
