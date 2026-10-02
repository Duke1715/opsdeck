/**
 * OpsDeck's own file icons: the type's letter(s) in its colour, set in Unbounded (bundled, so they
 * look the same everywhere); folders and unknown files are thin line icons like the sidebar.
 */
import "@fontsource/unbounded/latin-700.css";

type Glyph = { t: string; c: string; svg?: string };

// Helm: a ship's wheel drawn with lines (no font has a good one at 16 px)
const HELM = (c: string) => {
  const spokes = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4, x1 = 8 + Math.cos(a) * 2.2, y1 = 8 + Math.sin(a) * 2.2, x2 = 8 + Math.cos(a) * 6.6, y2 = 8 + Math.sin(a) * 6.6;
    return `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }).join("");
  return `<circle cx="8" cy="8" r="4.4" fill="none" stroke="${c}" stroke-width="1.4"/><circle cx="8" cy="8" r="1.3" fill="${c}"/><path d="${spokes}" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/>`;
};

// languages / formats: label + colour
const EXT: Record<string, Glyph> = {
  tf: { t: "T", c: "#a77bf3" }, tfvars: { t: "T", c: "#c9a7ff" }, hcl: { t: "H", c: "#a77bf3" }, nomad: { t: "N", c: "#5fd4a0" },
  yaml: { t: "Y", c: "#ef6f7b" }, yml: { t: "Y", c: "#ef6f7b" },
  json: { t: "{}", c: "#e6c07b" }, jsonc: { t: "{}", c: "#e6c07b" }, json5: { t: "{}", c: "#e6c07b" },
  ts: { t: "TS", c: "#4fa3f7" }, mts: { t: "TS", c: "#4fa3f7" }, cts: { t: "TS", c: "#4fa3f7" }, tsx: { t: "TX", c: "#4fa3f7" },
  js: { t: "JS", c: "#f5d76e" }, mjs: { t: "JS", c: "#f5d76e" }, cjs: { t: "JS", c: "#f5d76e" }, jsx: { t: "JX", c: "#f5d76e" },
  py: { t: "Py", c: "#5ab0e8" }, rs: { t: "R", c: "#e08a5c" }, go: { t: "Go", c: "#56c2d6" },
  java: { t: "J", c: "#e76f51" }, kt: { t: "K", c: "#b07cf0" }, rb: { t: "Rb", c: "#e0525c" }, php: { t: "P", c: "#8892bf" },
  c: { t: "C", c: "#7aa6da" }, h: { t: "h", c: "#7aa6da" }, cpp: { t: "C+", c: "#6295cb" }, hpp: { t: "h+", c: "#6295cb" }, cs: { t: "C#", c: "#9b7fe0" },
  lua: { t: "L", c: "#6c8ef0" }, swift: { t: "S", c: "#f0804f" }, dart: { t: "D", c: "#4fc3d7" },
  sh: { t: ">_", c: "#98d982" }, bash: { t: ">_", c: "#98d982" }, zsh: { t: ">_", c: "#98d982" }, fish: { t: ">_", c: "#98d982" },
  ps1: { t: ">_", c: "#5a9fd6" }, bat: { t: ">_", c: "#c0c0c0" },
  md: { t: "M", c: "#9fb4cc" }, mdx: { t: "M", c: "#9fb4cc" }, txt: { t: "≡", c: "#8a93a6" }, log: { t: "≡", c: "#7d8597" },
  sql: { t: "Q", c: "#e6a35c" }, prisma: { t: "P", c: "#5a67d8" }, graphql: { t: "G", c: "#e535ab" }, proto: { t: "Pb", c: "#7fb3d5" },
  html: { t: "<>", c: "#ef7d4f" }, htm: { t: "<>", c: "#ef7d4f" }, vue: { t: "V", c: "#4fc08d" }, svelte: { t: "S", c: "#ff5e3a" },
  css: { t: "#", c: "#5aa7f0" }, scss: { t: "#", c: "#e36fa4" }, less: { t: "#", c: "#5aa7f0" },
  toml: { t: "=", c: "#c0a080" }, ini: { t: "=", c: "#a0a8b8" }, conf: { t: "=", c: "#a0a8b8" }, cfg: { t: "=", c: "#a0a8b8" },
  properties: { t: "=", c: "#a0a8b8" }, env: { t: "E", c: "#e6c07b" }, xml: { t: "<>", c: "#d0a050" },
  j2: { t: "J2", c: "#d65a5a" }, jinja: { t: "J2", c: "#d65a5a" }, tpl: { t: "{{", c: "#7fdbca" }, gotmpl: { t: "{{", c: "#7fdbca" },
  pem: { t: "K", c: "#e6c07b" }, key: { t: "K", c: "#e6c07b" }, crt: { t: "C", c: "#7fdbca" }, cer: { t: "C", c: "#7fdbca" }, pub: { t: "K", c: "#98d982" },
  kdbx: { t: "K", c: "#6fbf73" }, csv: { t: "≣", c: "#6fbf73" }, tsv: { t: "≣", c: "#6fbf73" }, xlsx: { t: "X", c: "#3fa46a" },
  lock: { t: "L", c: "#7d8597" }, sum: { t: "L", c: "#7d8597" }, mod: { t: "Go", c: "#56c2d6" },
  zip: { t: "Z", c: "#c49a6c" }, gz: { t: "Z", c: "#c49a6c" }, tgz: { t: "Z", c: "#c49a6c" }, tar: { t: "Z", c: "#c49a6c" }, xz: { t: "Z", c: "#c49a6c" }, zst: { t: "Z", c: "#c49a6c" },
  deb: { t: "D", c: "#d64d6b" }, rpm: { t: "R", c: "#d64d6b" }, appimage: { t: "A", c: "#7fdbca" }, exe: { t: "X", c: "#5a9fd6" }, msi: { t: "X", c: "#5a9fd6" },
  png: { t: "◩", c: "#56c2a6" }, jpg: { t: "◩", c: "#56c2a6" }, jpeg: { t: "◩", c: "#56c2a6" }, gif: { t: "◩", c: "#56c2a6" }, webp: { t: "◩", c: "#56c2a6" }, ico: { t: "◩", c: "#56c2a6" },
  svg: { t: "◇", c: "#f0b45a" }, pdf: { t: "P", c: "#e05252" }, woff2: { t: "F", c: "#a0a8b8" }, ttf: { t: "F", c: "#a0a8b8" },
};

// whole file names (lower case)
const NAMES: Record<string, Glyph> = {
  dockerfile: { t: "D", c: "#3fa7f0" }, containerfile: { t: "D", c: "#3fa7f0" }, "docker-compose.yml": { t: "D", c: "#3fa7f0" },
  "docker-compose.yaml": { t: "D", c: "#3fa7f0" }, "compose.yml": { t: "D", c: "#3fa7f0" }, "compose.yaml": { t: "D", c: "#3fa7f0" },
  makefile: { t: "M", c: "#e08a5c" }, justfile: { t: "J", c: "#e08a5c" }, jenkinsfile: { t: "J", c: "#d24939" }, vagrantfile: { t: "V", c: "#4f8fd6" },
  ".gitignore": { t: "G", c: "#f05a3a" }, ".gitattributes": { t: "G", c: "#f05a3a" }, ".gitmodules": { t: "G", c: "#f05a3a" }, ".gitlab-ci.yml": { t: "GL", c: "#fc6d26" },
  ".dockerignore": { t: "D", c: "#3f7fb0" }, ".editorconfig": { t: "=", c: "#a0a8b8" }, ".env": { t: "E", c: "#e6c07b" },
  "package.json": { t: "N", c: "#6fbf4f" }, "package-lock.json": { t: "N", c: "#7d8597" }, "tsconfig.json": { t: "TS", c: "#4fa3f7" },
  "cargo.toml": { t: "R", c: "#e08a5c" }, "cargo.lock": { t: "R", c: "#7d8597" }, "go.mod": { t: "Go", c: "#56c2d6" }, "go.sum": { t: "Go", c: "#7d8597" },
  "chart.yaml": { t: "", c: "#4f8ff0", svg: HELM("#4f8ff0") }, "values.yaml": { t: "", c: "#6aa0f0", svg: HELM("#6aa0f0") }, "chart.lock": { t: "", c: "#7d8597", svg: HELM("#7d8597") }, "kustomization.yaml": { t: "K", c: "#4f8ff0" },
  "readme.md": { t: "i", c: "#7fdbca" }, license: { t: "©", c: "#e6c07b" }, "license.md": { t: "©", c: "#e6c07b" },
  ".terraform.lock.hcl": { t: "T", c: "#7d8597" }, ansible: { t: "A", c: "#e0525c" }, "ansible.cfg": { t: "A", c: "#e0525c" },
};

// folders with a meaning: tinted folder
const DIRS: Record<string, string> = {
  src: "#4fa3f7", lib: "#4fa3f7", app: "#4fa3f7", test: "#98d982", tests: "#98d982", spec: "#98d982", docs: "#7fdbca", doc: "#7fdbca",
  ".github": "#c0c8d8", ".gitlab": "#fc6d26", ".git": "#f05a3a", modules: "#a77bf3", terraform: "#a77bf3", infra: "#a77bf3",
  k8s: "#4f8ff0", kubernetes: "#4f8ff0", helm: "#4f8ff0", charts: "#4f8ff0", manifests: "#4f8ff0", deploy: "#4f8ff0",
  ansible: "#e0525c", roles: "#e0525c", playbooks: "#e0525c", scripts: "#98d982", bin: "#98d982", config: "#e6c07b", configs: "#e6c07b",
  node_modules: "#6a7385", target: "#6a7385", dist: "#6a7385", build: "#6a7385", vendor: "#6a7385", ".venv": "#6a7385",
  public: "#56c2a6", assets: "#56c2a6", static: "#56c2a6", images: "#56c2a6",
};

const DIR_DEFAULT = "#c9a86a";

const box = (inner: string, cls = "") =>
  `<svg class="fi ${cls}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${inner}</svg>`;

function label({ t, c, svg }: Glyph): string {
  if (svg) return box(svg);
  // one character big, two smaller; symbols get a system font fallback
  const size = t.length === 1 ? 11.5 : t.length === 2 ? 8 : 6.5;
  return box(`<text x="8" y="8.6" text-anchor="middle" dominant-baseline="middle" fill="${c}" font-size="${size}"
    font-family="Unbounded, 'JetBrains Mono', system-ui, sans-serif" font-weight="700" letter-spacing="${t.length > 1 ? -0.4 : 0}">${t
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>`);
}

/** Line folder, like the sidebar icons; tinted for well-known folder names. */
export function folderIcon(name: string, open = false): string {
  const c = DIRS[name.toLowerCase()] ?? DIR_DEFAULT;
  return open
    ? box(`<path d="M1.8 4.2V12.6c0 .5.4.9.9.9h9.8l2.2-6H4.6l-2.2 6M1.8 4.2c0-.5.4-.9.9-.9h3.2l1.4 1.5h4.5c.5 0 .9.4.9.9v1.8" fill="none" stroke="${c}" stroke-width="1.3" stroke-linejoin="round"/>`)
    : box(`<path d="M1.8 4.2c0-.5.4-.9.9-.9h3.2l1.4 1.5h6c.5 0 .9.4.9.9v6.6c0 .5-.4.9-.9.9H2.7c-.5 0-.9-.4-.9-.9z" fill="none" stroke="${c}" stroke-width="1.3" stroke-linejoin="round"/>`);
}

/** Icon for a file name (any path; only the last part counts). */
export function fileIcon(path: string): string {
  const name = path.split("/").pop()!.toLowerCase();
  const g = NAMES[name]
    ?? (name.startsWith("dockerfile") || name.endsWith(".dockerfile") ? NAMES.dockerfile : undefined)
    ?? (name.startsWith(".env") ? NAMES[".env"] : undefined)
    ?? EXT[name.includes(".") ? name.split(".").pop()! : ""];
  if (g) return label(g);
  // unknown: a plain page with a folded corner
  return box(`<path d="M4 1.8h5.2L12.4 5v8.6c0 .3-.3.6-.6.6H4c-.3 0-.6-.3-.6-.6V2.4c0-.3.3-.6.6-.6z M9 1.8V5.3h3.4" fill="none" stroke="#8a93a6" stroke-width="1.2" stroke-linejoin="round"/>`);
}
