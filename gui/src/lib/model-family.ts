/*
 * Model families and "latest per family", adapted from Magpie (https://github.com/yetone/magpie),
 * MIT License, Copyright (c) yetone: `FamilyOf`, `newerInFamily` and `BestInFamily` in
 * internal/catalog/family.go.
 *
 * MIT License
 *
 * Copyright (c) 2026 yetone
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Changes from the original: TypeScript; ids only (OpenCodex's pickers carry no release date, so
 * the release-date tie-break is gone and the later snapshot decides directly). Pure: no React,
 * no storage.
 *
 * A model's family is its id with the version numbers taken out, so claude-opus-4-8 and
 * claude-opus-5-5 are claude-opus, o3 and o1 are o, and o4-mini is o-mini. Read off the id alone:
 *
 *   - a version: a number (4, 4.5), the digits a word ends in (qwen3, o4, k2), a v and its digits
 *     (v3, v1:0), or the digits a word starts with that aren't a size (gpt-4o is gpt-o);
 *   - a size, which stays in the name: 8b, 70b, 1.5b, a22b, 8x7b, 128e, 32k;
 *   - a snapshot: a date or revision (20251101, 0528, 2507, 2024-08-06, 05-20, 001);
 *   - a preview (preview, exp, beta): the same model before its release;
 *   - latest, an alias of the newest.
 *
 * Every other word stays in the name: -mini, -pro, -flash-lite, -codex, :free, a provider prefix.
 */

export interface ModelFamily {
  /** The id, lowercased, without its version, snapshot or preview. */
  name: string;
  /** Every version number, in the order the id has them. */
  version: number[];
  /** Its dates or revision, "" for an alias. */
  snapshot: string;
  preview: boolean;
}

const SEP = /[-_/:@[\]\s]+/;
const SEP_ALL = /[-_/:@[\]\s]+/g;
const NUM = /^\d+(?:\.\d+)*$/;
const TAIL = /^([a-z][a-z.]*?[a-z])(\d+(?:\.\d+)*)$|^([a-z])(\d+(?:\.\d+)*)$/;
const HEAD = /^(\d+(?:\.\d+)*)([a-z]+)$/;
const SIZE = /^(?:[a-z]?\d+(?:\.\d+)?|\d+x\d+(?:\.\d+)?)[bmkte]$/;
const YEAR = /^(?:19|20)\d\d$/;
const PREVIEW = new Set(["preview", "exp", "experimental", "beta", "alpha"]);

/** What an id's name says about it: the family it belongs to and where it stands in it. */
export function familyOf(id: string): ModelFamily {
  const s = id.trim().toLowerCase();
  const words = s.split(SEP);
  const seps = s.match(SEP_ALL) ?? [];
  // which purely numeric words are a snapshot rather than a version
  const snap = words.map((w) => NUM.test(w) && !w.includes(".") && (w.length >= 4 || (w.length >= 2 && w[0] === "0")));
  words.forEach((w, i) => {
    if (snap[i] || !NUM.test(w) || w.length !== 2) return;
    // the day after a month (05-20), the month before a year (12-2024)
    if ((i > 0 && snap[i - 1]) || (i + 1 < words.length && YEAR.test(words[i + 1]!))) snap[i] = true;
  });
  const version: number[] = [];
  let name = "";
  const snaps: string[] = [];
  let preview = false;
  const keep = (i: number, w: string) => {
    if (name.length > 0 && i > 0) name += seps[i - 1] ?? "";
    name += w;
  };
  const addVersion = (v: string) => {
    for (const n of v.split(".")) {
      const x = Number.parseInt(n, 10);
      version.push(Number.isFinite(x) ? x : 0);
    }
  };
  words.forEach((w, i) => {
    if (w === "") return;
    if (snap[i]) { snaps.push(w); return; }
    if (PREVIEW.has(w)) { preview = true; return; }
    if (w === "latest") return;
    if (NUM.test(w)) { addVersion(w); return; }
    if (SIZE.test(w)) { keep(i, w); return; }
    const tail = TAIL.exec(w);
    if (tail) {
      const word = tail[1] ?? tail[3]!;
      const v = tail[2] ?? tail[4]!;
      if (word !== "v") keep(i, word); // v3, v1: the version alone
      addVersion(v);
      return;
    }
    const head = HEAD.exec(w);
    if (head) {
      addVersion(head[1]!);
      keep(i, head[2]!);
      return;
    }
    keep(i, w);
  });
  // all numbers: a family of its own
  return { name: name || s, version, snapshot: snaps.join("-"), preview };
}

/** The family an id belongs to: two ids with the same key are versions of one model. */
export function modelFamilyKey(id: string): string {
  return familyOf(id).name;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/**
 * `a`, of the same family as `b`, is the one to show over it: the higher version; at the same
 * version a release over a preview, then the alias over a dated snapshot (the alias names the
 * vendor's current one), then the later snapshot.
 */
function newerInFamily(a: ModelFamily, b: ModelFamily): boolean {
  const c = compareVersions(a.version, b.version);
  if (c !== 0) return c > 0;
  if (a.preview !== b.preview) return b.preview;
  if ((a.snapshot === "") !== (b.snapshot === "")) return a.snapshot === "";
  // 2025-12-01 and 20251101 are both dates: compare the digits, not where the dashes fall
  return a.snapshot.replace(/-/g, "") > b.snapshot.replace(/-/g, "");
}

/**
 * `items` with only the newest of each family left, in their order. A family's first listed wins a
 * tie; every item carrying the winning id stays (two providers' rows can share one id).
 */
export function latestPerFamilyBy<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  const ids = items.map(idOf);
  const families = ids.map((id) => familyOf(id));
  const best = new Map<string, number>();
  families.forEach((family, i) => {
    const j = best.get(family.name);
    if (j === undefined || newerInFamily(family, families[j]!)) best.set(family.name, i);
  });
  return items.filter((_, i) => ids[best.get(families[i]!.name)!] === ids[i]);
}

/** `ids` with only the newest model of each family left, in their order. */
export function latestPerFamily(ids: readonly string[]): string[] {
  return latestPerFamilyBy(ids, (id) => id);
}
