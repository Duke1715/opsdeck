import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { esc, toast } from "./ui";

type UpdateInfo = { current: string; available: boolean; version?: string; notes?: string; date?: string };

let last: UpdateInfo | null = null;

/** "↑" on the ⚙ button while a newer version is available. */
function badge(on: boolean) {
  const b = document.querySelector<HTMLElement>("#sidebar [data-view=settings]");
  if (!b) return;
  b.classList.toggle("has-update", on);
  b.title = on ? `Настройки — доступна OpsDeck ${last?.version}` : "Настройки";
}

export async function checkUpdates(silent = false): Promise<UpdateInfo | null> {
  try {
    last = await invoke<UpdateInfo>("update_check");
    badge(last.available);
    if (last.available && silent) toast(`Доступна OpsDeck ${last.version} — ⚙ Настройки → Обновления`);
    window.dispatchEvent(new CustomEvent("update-info", { detail: last }));
    return last;
  } catch (e) {
    if (!silent) throw e;
    return null;
  }
}

/** Settings section: current version, check button, release notes, install with progress. */
export function mountUpdates(el: HTMLElement) {
  el.innerHTML = `
    <div class="row"><span>Установлена версия <b class="upd-cur">…</b></span><span class="spacer"></span>
      <button type="button" class="ghost" data-u="check">Проверить обновления</button></div>
    <div class="upd-result muted"></div>
    <div class="upd-new" hidden>
      <div class="row"><b class="upd-title"></b><span class="spacer"></span><button type="button" class="primary" data-u="install">Обновить и перезапустить</button></div>
      <pre class="upd-notes"></pre>
      <div class="upd-progress" hidden><div class="upd-bar"></div></div>
    </div>`;
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector<T>(s)!;

  const show = (u: UpdateInfo) => {
    $(".upd-cur").textContent = u.current;
    $(".upd-new").hidden = !u.available;
    $(".upd-result").textContent = u.available ? "" : "✓ Это последняя версия";
    if (u.available) {
      $(".upd-title").textContent = `Доступна версия ${u.version}${u.date ? ` от ${new Date(u.date).toLocaleDateString()}` : ""}`;
      $(".upd-notes").innerHTML = esc(u.notes?.trim() || "Описание изменений — на странице релиза на GitHub.");
    }
  };

  el.addEventListener("click", async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-u]")?.dataset.u;
    if (act === "check") {
      $(".upd-result").textContent = "Проверяю…";
      try { const u = await checkUpdates(); if (u) show(u); } catch (err) { $(".upd-result").textContent = String(err); }
    }
    if (act === "install") {
      const btn = $<HTMLButtonElement>("[data-u=install]");
      btn.disabled = true;
      btn.textContent = "Скачиваю…";
      $(".upd-progress").hidden = false;
      try {
        await invoke("update_install"); // restarts the app on success
      } catch (err) {
        toast(String(err), "err");
        btn.disabled = false;
        btn.textContent = "Обновить и перезапустить";
        $(".upd-progress").hidden = true;
      }
    }
  });

  listen<{ downloaded?: number; total?: number | null; installing?: boolean }>("update-progress", (e) => {
    const p = e.payload;
    const btn = $<HTMLButtonElement>("[data-u=install]");
    if (p.installing) { btn.textContent = "Устанавливаю… приложение перезапустится"; $(".upd-bar").style.width = "100%"; return; }
    if (p.total) $(".upd-bar").style.width = `${Math.min(100, (100 * (p.downloaded ?? 0)) / p.total)}%`;
    btn.textContent = `Скачиваю… ${((p.downloaded ?? 0) / 1048576).toFixed(1)} МБ${p.total ? ` из ${(p.total / 1048576).toFixed(1)}` : ""}`;
  });
  window.addEventListener("update-info", (e) => show((e as CustomEvent<UpdateInfo>).detail));
  if (last) show(last);
  else invoke<UpdateInfo>("update_check").then(show).catch((err) => {
    // not reachable / no releases yet: still show the installed version
    invoke<string>("app_version").then((v) => ($(".upd-cur").textContent = v)).catch(() => {});
    $(".upd-result").textContent = String(err);
  });
}
