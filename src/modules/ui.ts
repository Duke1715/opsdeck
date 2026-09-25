export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Modal confirm / prompt. Resolves to the entered value ("" for plain confirm) or null on cancel.
 * Used instead of window.confirm/prompt, which webviews don't reliably support.
 */
export function ask(
  title: string,
  message: string,
  opts: { input?: string; placeholder?: string; ok?: string; danger?: boolean } = {},
): Promise<string | null> {
  const dlg = document.createElement("dialog");
  dlg.className = "ask";
  dlg.innerHTML = `
    <form method="dialog">
      <h3>${esc(title)}</h3>
      <p class="msg">${esc(message)}</p>
      ${opts.input !== undefined ? `<input name="v" value="${esc(opts.input)}" placeholder="${esc(opts.placeholder ?? "")}" spellcheck="false" autocomplete="off" />` : ""}
      <div class="actions">
        <button value="cancel" formnovalidate>Отмена</button>
        <button value="ok" class="${opts.danger ? "danger-solid" : "primary"}">${esc(opts.ok ?? "OK")}</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      const input = dlg.querySelector("input");
      resolve(dlg.returnValue === "ok" ? (input?.value.trim() ?? "") : null);
      dlg.remove();
    });
    dlg.showModal();
    dlg.querySelector<HTMLInputElement>("input")?.select();
  });
}

export function toast(text: string, kind: "ok" | "err" = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 7000 : 3000);
}
