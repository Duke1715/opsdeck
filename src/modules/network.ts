import { helpBtn } from "./help";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

const TOOLS: Record<string, { label: string; fields: ("count" | "server" | "record" | "port")[] }> = {
  ping: { label: "ping", fields: ["count"] },
  mtr: { label: "mtr (report)", fields: ["count"] },
  traceroute: { label: "traceroute", fields: [] },
  dig: { label: "dig", fields: ["record", "server"] },
  nslookup: { label: "nslookup", fields: ["record", "server"] },
  port: { label: "TCP-порт", fields: ["port"] },
};
const RECORDS = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "SRV", "PTR", "CAA", "ANY"];

let seq = 0;

export function mountNetwork(root: HTMLElement) {
  root.innerHTML = `
    <div class="page net">
      <h2>Сеть и DNS ${helpBtn("net")}</h2>
      <form class="toolbar">
        <select name="tool"></select>
        <input name="target" placeholder="хост или IP, например 8.8.8.8" required autocomplete="off" spellcheck="false" />
        <label data-f="count">кол-во <input name="count" type="number" min="1" max="1000" value="4" /></label>
        <label data-f="record">тип <select name="record"></select></label>
        <label data-f="server">DNS <input name="server" placeholder="по умолчанию" spellcheck="false" /></label>
        <label data-f="port">порт <input name="port" type="number" min="1" max="65535" value="443" /></label>
        <button type="submit" class="primary">Запустить</button>
        <button type="button" data-act="stop" disabled>Стоп</button>
        <button type="button" data-act="clear" class="ghost">Очистить</button>
      </form>
      <pre class="output"></pre>
    </div>`;

  const form = root.querySelector<HTMLFormElement>("form")!;
  const out = root.querySelector<HTMLElement>(".output")!;
  const stopBtn = root.querySelector<HTMLButtonElement>("[data-act=stop]")!;
  const runBtn = root.querySelector<HTMLButtonElement>("[type=submit]")!;
  const toolSel = form.elements.namedItem("tool") as HTMLSelectElement;
  const recordSel = form.elements.namedItem("record") as HTMLSelectElement;

  for (const [id, t] of Object.entries(TOOLS)) toolSel.add(new Option(t.label, id));
  for (const r of RECORDS) recordSel.add(new Option(r, r));

  const syncFields = () => {
    const f = TOOLS[toolSel.value].fields;
    root.querySelectorAll<HTMLElement>("[data-f]").forEach((el) => (el.hidden = !f.includes(el.dataset.f as never)));
  };
  toolSel.onchange = syncFields;
  syncFields();

  let current: { runId: string; unlisten: UnlistenFn[] } | null = null;

  const append = (text: string, cls = "") => {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
  };

  const finish = () => {
    current?.unlisten.forEach((u) => u());
    current = null;
    stopBtn.disabled = true;
    runBtn.disabled = false;
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (current) return;
    const v = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
    const runId = `run${++seq}`;
    const unlisten = [
      await listen<{ stream: string; text: string }>(`tool-line-${runId}`, (ev) =>
        append(ev.payload.text, ev.payload.stream === "err" ? "err" : "")),
      await listen<number | null>(`tool-exit-${runId}`, (ev) => {
        append(`— завершено, код ${ev.payload ?? "прерван"}`, "muted");
        finish();
      }),
    ];
    current = { runId, unlisten };
    stopBtn.disabled = false;
    runBtn.disabled = true;
    try {
      const cmd = await invoke<string>("tool_run", {
        runId,
        req: {
          tool: toolSel.value, target: v("target"), count: Number(v("count")) || undefined,
          record: v("record"), server: v("server") || undefined, port: Number(v("port")) || undefined,
        },
      });
      append(`$ ${cmd}`, "cmd");
    } catch (err) {
      append(String(err), "err");
      finish();
    }
  };

  stopBtn.onclick = () => current && invoke("tool_stop", { runId: current.runId });
  root.querySelector<HTMLElement>("[data-act=clear]")!.onclick = () => (out.textContent = "");
}
