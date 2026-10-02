/** Pure translation logic (no DOM): shared by the app and scripts/i18n-check. */
const CYR = /[А-Яа-яЁё]/;

// patterns: "Удалить «{}»?" → /^Удалить «(.+?)»\?$/u ; longer literal text wins.
// A placeholder never starts or ends inside a word (so "{} с{}" can't eat the "с" of "словами"),
// and patterns with almost no text of their own are not used at all — they match too much.
export type Pat = { re: RegExp; out: string; weight: number };
export function buildPatterns(d: Record<string, string>): Pat[] {
  const esc = (x: string) => x.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
  const letter = /\p{L}/u;
  return Object.entries(d)
    .filter(([k]) => k.includes("{}"))
    .flatMap(([k, out]) => {
      const lits = k.split("{}");
      const weight = (lits.join("").match(/\p{L}/gu) ?? []).length;
      if (weight < 3 && lits[lits.length - 1] === "") return []; // "{} с{}", "{}д {}ч{}"…
      // "{}{}" can't be split reliably ("0.4.2 от 03.10" → "0" + ".4.2 от…"); such texts get
      // explicit variants in the dictionary instead
      if (k.includes("{}{}")) return [];
      let re = "^";
      lits.forEach((lit, i) => {
        if (i > 0) re += "(.+?)";
        if (i > 0 && letter.test(lit[0] ?? "")) re += "(?<!\\p{L})";
        re += esc(lit);
        if (i < lits.length - 1 && letter.test(lit[lit.length - 1] ?? "")) re += "(?!\\p{L})";
      });
      return [{ re: new RegExp(re + "$", "su"), out, weight }];
    })
    .sort((a, b) => b.weight - a.weight);
}

/** A translator for one dictionary: exact strings, then patterns, then line by line. */
export function makeTr(dict: Record<string, string>, pats: Pat[]) {
  const tr = (s: string): string => {
    if (!CYR.test(s)) return s;
    const lead = /^\s*/.exec(s)![0], trail = /\s*$/.exec(s)![0];
    const key = s.replace(/\s+/g, " ").trim();
    const hit = dict[key];
    if (hit !== undefined) return lead + hit + trail;
    for (const p of pats) {
      const m = p.re.exec(key);
      if (m) {
        let i = 1;
        // the captured parts may themselves be UI strings (a status inside a sentence)
        return lead + p.out.replace(/\{\}/g, () => tr(m[i++] ?? "")) + trail;
      }
    }
    // multi-line messages (backend errors with details): translate line by line
    if (s.includes("\n")) return s.split("\n").map(tr).join("\n");
    return s;
  };
  return tr;
}
