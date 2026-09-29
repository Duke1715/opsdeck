import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ShellBlocks } from "./blocks";
import { hlPrefs, InputHighlighter, OutputHighlighter, type HlPrefs } from "./highlight";

let seq = 0;

export type SpawnOpts = { program?: string; args?: string[]; cwd?: string; env?: Record<string, string> };

const theme = {
  background: "#0f1117", foreground: "#d6deeb", cursor: "#7fdbca", selectionBackground: "#2b3a55",
  black: "#1d2130", red: "#ef5f6b", green: "#98d982", yellow: "#e6c07b", blue: "#61afef",
  magenta: "#c678dd", cyan: "#56b6c2", white: "#d6deeb",
};

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** xterm.js bound to a backend PTY running `program` (defaults to $SHELL). */
export class PtyTerminal {
  readonly id = `pty${++seq}`;
  readonly term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 13, cursorBlink: true,
    scrollback: 20000, theme, allowProposedApi: true, overviewRulerWidth: 8,
  });
  /** Command blocks (only populated when the shell integration is active). */
  readonly blocks = new ShellBlocks(this.term);
  private fit = new FitAddon();
  private outHl = new OutputHighlighter(this.term, this.blocks);
  private inHl = new InputHighlighter(this.term, this.blocks);
  private hl: HlPrefs = hlPrefs();
  private onHl = (e: Event) => {
    this.hl = (e as CustomEvent<HlPrefs>).detail;
    this.inHl.setEnabled(this.hl.input);
  };
  private unlisten: UnlistenFn[] = [];
  private ro: ResizeObserver;
  onExit?: () => void;

  constructor(readonly host: HTMLElement, readonly spawn: SpawnOpts = {}) {
    const opts = spawn;
    this.term.loadAddon(this.fit);
    this.term.open(host);
    this.inHl.setEnabled(this.hl.input);
    window.addEventListener("term-highlight", this.onHl);
    this.term.onData((data) => invoke("pty_write", { id: this.id, data }));
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
      const k = e.key.toUpperCase();
      // preventDefault: otherwise WebKit also runs its own copy/paste for the same keys
      // and the text lands in the terminal twice
      if (k === "C" && this.term.hasSelection()) {
        e.preventDefault();
        invoke("clip_write", { text: this.term.getSelection() });
        return false;
      }
      if (k === "V") {
        e.preventDefault();
        invoke<string>("clip_read").then((t) => t && this.term.paste(t));
        return false;
      }
      return true;
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.start(opts);
  }

  private async start(opts: SpawnOpts) {
    this.unlisten.push(await listen<string>(`pty-data-${this.id}`, (e) => this.term.write(this.outHl.feed(b64(e.payload), this.hl.output))));
    this.unlisten.push(await listen(`pty-exit-${this.id}`, () => {
      this.term.write("\r\n\x1b[2m[процесс завершён]\x1b[0m\r\n");
      this.onExit?.();
    }));
    this.safeFit();
    try {
      await invoke("pty_spawn", { req: { id: this.id, ...opts, cols: this.term.cols, rows: this.term.rows } });
    } catch (e) {
      this.term.write(`\x1b[31mНе удалось запустить ${opts.program ?? "shell"}: ${e}\x1b[0m\r\n`);
    }
  }

  private safeFit() {
    if (this.host.offsetParent !== null && this.host.clientWidth > 0) this.fit.fit();
  }

  resize() {
    const { cols, rows } = this.term;
    this.safeFit();
    if (cols !== this.term.cols || rows !== this.term.rows)
      invoke("pty_resize", { id: this.id, cols: this.term.cols, rows: this.term.rows }).catch(() => {});
  }

  send(text: string) {
    return invoke("pty_write", { id: this.id, data: text });
  }

  dispose() {
    this.ro.disconnect();
    window.removeEventListener("term-highlight", this.onHl);
    this.unlisten.forEach((u) => u());
    invoke("pty_kill", { id: this.id });
    this.term.dispose();
  }
}
