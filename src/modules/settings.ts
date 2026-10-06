import { helpBtn } from "./help";
import { langSetting, setLang, t } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { ask, esc, toast } from "./ui";
import { mountSnippets } from "./snippets";
import { mountUpdates } from "./updates";
import { hlPrefs, setHlPrefs } from "./highlight";
import { setTermFontSize, termFontSize, setTermFontFamily, termFontFamily, TERM_FONTS, fontInstalled } from "./pty";
import { setSuggestEnabled, suggestEnabled } from "./suggest";
import { listen } from "@tauri-apps/api/event";

const AUTHOR_TG = "https://t.me/sys_admin_expert";
const REPO_URL = "https://github.com/LeoAlecksey/opsdeck";
const DONATE_URL = "https://yoomoney.ru/to/4100119645604976";

type AiStatus = { engine: boolean; model: boolean; running: boolean; installing: boolean; size: number; download_size: number; dir: string; supported: boolean };
const gb = (b: number) => `${(b / 1073741824).toFixed(2)} ГБ`;

/** Install / remove the local model, with download progress. */
function mountAi(el: HTMLElement) {
  const draw = async () => {
    const st = await invoke<AiStatus>("ai_status").catch(() => null);
    if (!st) { el.textContent = "статус недоступен"; return; }
    const ready = st.engine && st.model;
    el.innerHTML = !st.supported ? `<p class="muted">Для этой платформы встроенной модели пока нет.</p>` : `
      <div class="row"><span>${ready ? `✓ Установлен${st.running ? " · модель загружена в память" : ""} · ${gb(st.size)}` : st.installing ? "Скачивается…" : `Не установлен · скачать ≈${gb(st.download_size)}`}</span>
        <span class="spacer"></span>
        ${st.installing ? `<button type="button" class="ghost" data-ai="cancel">Отменить</button>`
          : ready ? `<button type="button" class="ghost" data-ai="remove">Удалить</button>`
          : `<button type="button" class="primary" data-ai="install">${st.size > 0 ? "Докачать" : "Установить"}</button>`}</div>
      <div class="upd-progress ai-prog" ${st.installing ? "" : "hidden"}><div class="upd-bar"></div></div>
      <div class="ai-stage muted"></div>
      <div class="muted small-path" title="Папка с движком и моделью">${esc(st.dir)}</div>`;
  };
  el.addEventListener("click", async (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-ai]")?.dataset.ai;
    try {
      if (a === "install") { await invoke("ai_install"); await draw(); }
      if (a === "cancel") await invoke("ai_cancel");
      if (a === "remove") {
        if ((await ask("Удалить локальный ИИ", "Удалить движок и модель (≈1,1 ГБ)? Потом их можно скачать снова.", { ok: "Удалить", danger: true })) === null) return;
        await invoke("ai_remove");
        await draw();
      }
    } catch (err) { toast(String(err), "err"); }
  });
  listen<{ stage: string; done: number; total: number }>("ai-progress", (e) => {
    const p = e.payload;
    const bar = el.querySelector<HTMLElement>(".ai-prog");
    if (bar) { bar.hidden = false; (bar.firstElementChild as HTMLElement).style.width = p.total ? `${(100 * p.done) / p.total}%` : "5%"; }
    const s = el.querySelector(".ai-stage");
    if (s) s.textContent = `${p.stage === "engine" ? "Движок llama.cpp" : "Модель Qwen2.5-Coder 1.5B"}: ${(p.done / 1048576).toFixed(0)}${p.total ? ` из ${(p.total / 1048576).toFixed(0)}` : ""} МБ`;
  });
  listen<{ ok: boolean; error?: string }>("ai-installed", (e) => {
    if (e.payload.ok) toast("Локальный ИИ установлен — в терминале Ctrl+Shift+K или кнопка ✦ ИИ");
    else toast(`Локальный ИИ: ${e.payload.error}`, "err");
    draw();
  });
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "settings") draw(); });
  draw();
}

type Settings = {
  keepass_path: string; keepass_keyfile: string; keepass_lock_minutes: number; keepass_keep_open: boolean;
  obsidian_vault: string; winbox_path: string; k8s_include_system: boolean; update_auto_check: boolean;
};
type Detected = { keepass: string[]; obsidian: string[]; winbox: string[] };

export function mountSettings(root: HTMLElement) {
  root.innerHTML = `
    <div class="page settings">
      <h2>Настройки ${helpBtn("settings")}</h2>
      <fieldset class="lang-field" data-no-i18n><legend>Язык · Language</legend>
        <select class="lang-sel">
          <option value="auto">Как в системе · System</option>
          <option value="ru">Русский</option>
          <option value="en">English</option>
        </select>
      </fieldset>
      <form>
        <fieldset><legend>KeePass</legend>
          <label>База .kdbx <input name="keepass_path" list="dl-kp" spellcheck="false" /></label>
          <label>Ключевой файл (необязательно) <input name="keepass_keyfile" spellcheck="false" /></label>
          <label class="check"><input type="checkbox" name="keepass_keep_open" /> Держать базу открытой до закрытия OpsDeck (пароль вводится один раз за запуск)</label>
          <label>Автоблокировка, минут без действий (0 — выключить; работает, если галочка выше снята) <input name="keepass_lock_minutes" type="number" min="0" max="1440" /></label>
          <p class="muted hint">Пока база открыта, OpsDeck следит за файлом .kdbx: изменения, сохранённые в KeePassXC или пришедшие синхронизацией, подтягиваются сами.</p>
        </fieldset>
        <fieldset class="hl-field"><legend>Терминал</legend>
          <label class="check"><input type="checkbox" data-hl="input" /> Подсветка команды при наборе (как в fish: несуществующая команда — красным)</label>
          <label class="check"><input type="checkbox" data-hl="output" /> Подсветка вывода: ERROR/WARN, статусы подов, IP, ссылки, время</label>
          <label class="check"><input type="checkbox" class="term-sugg" /> Подсказывать продолжение команды серым (из истории и заметок), → — принять</label>
          <label>Размер шрифта (8–32; ещё Ctrl+= / Ctrl+- / Ctrl+0 и Ctrl+колесо в терминале) <input class="term-font" type="number" min="8" max="32" /></label>
          <label>Шрифт терминала <select class="term-font-family"></select></label>
          <label class="term-font-custom-row" hidden>Название шрифта <input class="term-font-custom" maxlength="128" spellcheck="false" placeholder="например, Iosevka" data-no-i18n /></label>
          <p class="muted hint term-font-warn" hidden></p>
          <p class="muted hint">Шрифты из списка, которых нет в системе, помечены «не установлен» — их нужно поставить отдельно, иначе используется запасной. Для иконок Powerlevel10k — MesloLGS NF или Nerd Font. Любой другой установленный шрифт — пункт «Другой…». Выбор сохраняется и сразу применяется ко всем терминалам, включая SSH и AI.</p>
          <p class="muted hint">Применяется сразу. Подсветка ввода работает в локальных вкладках (нужна интеграция с bash/zsh). Вывод, который программа уже раскрасила сама, и полноэкранные программы (vim, htop, less) не трогаются.</p>
        </fieldset>
        <fieldset class="ai-field"><legend>Локальный ИИ</legend>
          <div class="ai-root"></div>
          <p class="muted hint">Модель Qwen2.5-Coder 1.5B и движок llama.cpp скачиваются отдельно (≈1,1 ГБ) и работают только на этом компьютере — запросы никуда не уходят. В терминале ${"Ctrl+Shift+K"} или кнопка «✦ ИИ»: опишите словами, что сделать, — ИИ предложит команду с учётом ваших заметок и истории. Модель запускается при первом запросе и выгружается из памяти через 15 минут без дела.</p>
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
      <p class="about muted">OpsDeck <span class="about-ver"></span> ·
        <a href="${AUTHOR_TG}" data-ext title="Telegram-канал автора">канал автора в Telegram</a> ·
        <a href="${REPO_URL}" data-ext title="Исходный код, задачи и релизы">GitHub</a> ·
        <a href="${DONATE_URL}" data-ext title="Перевод автору через ЮMoney — по желанию">поддержать проект</a></p>
    </div>`;

  const form = root.querySelector("form")!;
  const langSel = root.querySelector<HTMLSelectElement>(".lang-sel")!;
  langSel.value = langSetting();
  langSel.onchange = () => setLang(langSel.value as "auto" | "ru" | "en");
  invoke<string>("app_version").then((v) => (root.querySelector(".about-ver")!.textContent = `v${v}`)).catch(() => {});
  // links open in the system browser / Telegram, not inside the app window
  root.querySelector(".about")!.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-ext]");
    if (!a) return;
    e.preventDefault();
    invoke("open_external", { url: a.href }).catch((err) => toast(String(err), "err"));
  });
  mountSnippets(root.querySelector<HTMLElement>(".sn-root")!);
  mountUpdates(root.querySelector<HTMLElement>(".upd-root")!);
  const hlBoxes = root.querySelectorAll<HTMLInputElement>("[data-hl]");
  const syncHl = () => { const p = hlPrefs(); hlBoxes.forEach((b) => (b.checked = p[b.dataset.hl as "input" | "output"])); };
  hlBoxes.forEach((b) => (b.onchange = () => setHlPrefs({ [b.dataset.hl!]: b.checked })));
  window.addEventListener("term-highlight", syncHl);
  syncHl();
  const sugg = root.querySelector<HTMLInputElement>(".term-sugg")!;
  sugg.checked = suggestEnabled();
  sugg.onchange = () => setSuggestEnabled(sugg.checked);
  mountAi(root.querySelector<HTMLElement>(".ai-root")!);
  const fontIn = root.querySelector<HTMLInputElement>(".term-font")!;
  const syncFont = () => { fontIn.value = String(termFontSize()); };
  fontIn.onchange = () => { if (Number(fontIn.value)) setTermFontSize(Number(fontIn.value)); syncFont(); };
  window.addEventListener("term-font", syncFont);
  syncFont();
  const fontSel = root.querySelector<HTMLSelectElement>(".term-font-family")!;
  const fontCustomRow = root.querySelector<HTMLElement>(".term-font-custom-row")!;
  const fontCustom = root.querySelector<HTMLInputElement>(".term-font-custom")!;
  const fontWarn = root.querySelector<HTMLElement>(".term-font-warn")!;
  const OTHER = "__other__";
  const fillFonts = () => {
    fontSel.innerHTML = `<option value="">По умолчанию</option>` +
      TERM_FONTS.map((f) => `<option value="${esc(f)}">${esc(fontInstalled(f) ? f : `${f} — не установлен`)}</option>`).join("") +
      `<option value="${OTHER}">Другой…</option>`;
  };
  const showWarn = (name: string) => {
    fontWarn.hidden = !name || fontInstalled(name);
    fontWarn.textContent = fontWarn.hidden ? "" : `Шрифт «${name}» не найден в системе — терминал использует запасной.`;
  };
  const syncFontFamily = () => {
    const cur = termFontFamily();
    const known = !cur || TERM_FONTS.includes(cur);
    fontSel.value = known ? cur : OTHER;
    fontCustomRow.hidden = known;
    if (!known) fontCustom.value = cur;
    showWarn(cur);
  };
  fontSel.onchange = () => {
    if (fontSel.value === OTHER) {
      fontCustomRow.hidden = false;
      fontCustom.focus();
      return;
    }
    fontCustomRow.hidden = true;
    setTermFontFamily(fontSel.value);
  };
  fontCustom.onchange = () => setTermFontFamily(fontCustom.value);
  window.addEventListener("term-font-family", syncFontFamily);
  fillFonts();
  syncFontFamily();
  invoke<string>("logs_path").then((p) => (root.querySelector(".log-path")!.textContent = p)).catch(() => {});
  root.querySelector<HTMLElement>(".log-field")!.addEventListener("click", async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-log]")?.dataset.log;
    if (!act) return;
    if (act === "open") return void invoke("logs_open").catch((err) => toast(String(err), "err"));
    const view = root.querySelector<HTMLElement>(".log-view")!;
    view.hidden = false;
    view.textContent = "загрузка…";
    const text = await invoke<string>("logs_tail", { lines: 300, onlyProblems: act === "problems" }).catch((err) => String(err));
    view.textContent = text || t(act === "problems" ? "Проблем не записано ✓" : "Журнал пуст");
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
      keepass_keep_open: f("keepass_keep_open").checked,
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
