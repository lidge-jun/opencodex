#!/usr/bin/env node
// Mechanical gate for devlog/_plan/261123_proxy_upstream_catchup (c6).
// Usage: node check.mjs   (run from any cwd; resolves paths relative to this file)
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const errors = [];
const fail = (m) => errors.push(m);
const read = (f) => readFileSync(join(dir, f), "utf8");

// 1. research docs present, cite both sides, carry NOT RUN
const research = ["000_plan.md","001_cliproxyapi_wire.md","002_cliproxyapi_ops.md","003_ccswitch.md","004_sub2api_gateway.md","005_sub2api_platform.md","006_magpie_gateway.md","007_magpie_clients.md","008_opencodex_baseline.md","009_gap_matrix.md"];
const refPrefix = {"001":"cpa:","002":"cpa:","003":"ccs:","004":"s2a:","005":"s2a:","006":"mgp:","007":"mgp:"};
for (const f of research) {
  if (!existsSync(join(dir, f))) { fail("missing research doc " + f); continue; }
  const t = read(f);
  if (!/NOT RUN/.test(t)) fail(f + ": no NOT RUN section");
  const n = f.slice(0, 3);
  if (refPrefix[n]) {
    if (!t.includes(refPrefix[n])) fail(f + ": no " + refPrefix[n] + " reference citation");
    if (!/ocx:[\w./-]+:\d+/.test(t)) fail(f + ": no ocx:<path>:<line> citation");
  }
  if (n === "008" && !/ocx:[\w./-]+:\d+/.test(t)) fail(f + ": baseline has no ocx path:line citation");
}

// 2. gap matrix rows: | G-xxx | ... | phase |  (phase = 0X0 | REJECT | DEFER)
const matrix = existsSync(join(dir, "009_gap_matrix.md")) ? read("009_gap_matrix.md") : "";
const rows = new Map();
for (const line of matrix.split("\n")) {
  const m = line.match(/^\|\s*(G-\d{3})\s*\|(.*)\|\s*$/);
  if (!m) continue;
  const cells = m[2].split("|").map((c) => c.trim());
  if (cells.length < 6) continue; // other tables (e.g. DEFER/REJECT reasons) cite ids too
  const phase = cells[cells.length - 1].replace(/[\x60*]/g, "");
  if (rows.has(m[1])) fail("duplicate matrix id " + m[1]);
  rows.set(m[1], { phase, cells });
  if (cells.length < 6) fail(m[1] + ": matrix row has fewer than 7 columns");
  if (!/^(0[1-9]0|REJECT|DEFER|CLOSED)$/.test(phase)) fail(m[1] + ": phase cell '" + phase + "' must be 0X0, REJECT, DEFER or CLOSED");
}
if (rows.size === 0) fail("009_gap_matrix.md has no G-xxx rows");

// 3. phase docs: decade docs 0X0_*.md with a "Gaps:" line
const phaseDocs = readdirSync(dir).filter((f) => /^0[1-9]0_.*\.md$/.test(f)).sort();
const usedPhases = new Set([...rows.values()].map((r) => r.phase).filter((p) => /^0\d0$/.test(p)));
const seen = new Map();
const decades = phaseDocs.map((f) => f.slice(0, 3));
for (let i = 0; i < decades.length; i++) {
  const want = String((i + 1) * 10).padStart(3, "0");
  if (decades[i] !== want) fail("phase docs not contiguous: expected " + want + " got " + decades[i]);
}
for (const p of usedPhases) if (!decades.includes(p)) fail("matrix references phase " + p + " but no " + p + "_*.md exists");
for (const f of phaseDocs) {
  const t = read(f);
  const p = f.slice(0, 3);
  const g = t.match(/^\*\*Gaps:\*\*(.*)$/m);
  if (!g) { fail(f + ": no **Gaps:** line"); continue; }
  const ids = [...g[1].matchAll(/G-\d{3}/g)].map((x) => x[0]);
  if (ids.length === 0) fail(f + ": **Gaps:** line lists no ids");
  for (const id of ids) {
    if (!rows.has(id)) fail(f + ": " + id + " not in matrix");
    else if (rows.get(id).phase !== p) fail(f + ": " + id + " assigned to " + rows.get(id).phase + " in matrix");
    if (seen.has(id)) fail(id + " appears in both " + seen.get(id) + " and " + f);
    seen.set(id, f);
  }
  for (const h of ["## Goal","## Why","## Changes","## Dependencies","## Acceptance","## Verification","## Risks","## Non-goals"]) {
    if (!t.includes(h)) fail(f + ": missing section '" + h + "'");
  }
  // Before/After: inside Changes, a quoted pinned anchor plus a "// before" and a "// after" code block.
  const ba = ((t.split(/^## Changes\s*$/m)[1] || "").split(/^## /m)[0].split(/^### Before \/ After\s*$/m)[1]) || "";
  if (!ba) fail(f + ": no '### Before / After' subsection in Changes");
  else {
    if (!/ocx:[\w./@-]+:[1-9]\d*/.test(ba)) fail(f + ": Before / After names no ocx:<path>:<line> location");
    const blocks = [...ba.matchAll(/```\w*\n([\s\S]*?)```/g)].map((x) => x[1]);
    if (!blocks.some((b) => /^\/\/ before/m.test(b))) fail(f + ": Before / After has no '// before' code block");
    if (!blocks.some((b) => /^\/\/ after/m.test(b))) fail(f + ": Before / After has no '// after' code block");
  }
}
for (const [id, r] of rows) if (/^0\d0$/.test(r.phase) && !seen.has(id)) fail(id + ": adopted for " + r.phase + " but absent from that phase doc");
for (const [id, r] of rows) if (!/^0\d0$/.test(r.phase) && seen.has(id)) fail(id + ": " + r.phase + " in matrix but listed in " + seen.get(id));

// 3b. declared dependencies: 009 phase table "| [0X0](file) | topic | gaps | deps | why |" must match each doc's **Depends on:** and point backwards
const normDeps = (s) => (s.match(/0[1-9]0/g) || []).sort().join(",");
const tableDeps = new Map();
for (const line of matrix.split("\n")) {
  const m = line.match(/^\|\s*\[(0[1-9]0)\]\(([^)]+)\)\s*\|/);
  if (!m) continue;
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  tableDeps.set(m[1], normDeps(cells[3] || ""));
  if (!existsSync(join(dir, m[2]))) fail("009 phase table links missing doc " + m[2]);
}
for (const f of phaseDocs) {
  const p = f.slice(0, 3);
  const dl = (read(f).match(/^\*\*Depends on:\*\*(.*)$/m) || [, null])[1];
  if (dl === null) { fail(f + ": no **Depends on:** line"); continue; }
  const deps = normDeps(dl);
  if (!tableDeps.has(p)) fail("009 phase table has no row for " + p);
  else if (tableDeps.get(p) !== deps) fail(f + ": Depends on '" + deps + "' differs from 009 table '" + tableDeps.get(p) + "'");
  for (const d of deps ? deps.split(",") : []) {
    if (Number(d) >= Number(p)) fail(f + ": depends on later or same phase " + d);
    if (!decades.includes(d)) fail(f + ": depends on missing phase " + d);
  }
}

// 3c. Changes tables: every MODIFY row names a pinned anchor; every ocx: anchor resolves when the pinned export is present
const pinned = resolve(dir, "../../../.tmp/chase/opencodex-dev");
const havePinned = existsSync(pinned);
let anchors = 0;
for (const f of phaseDocs) {
  const t = read(f);
  const sec = (t.split(/^## Changes\s*$/m)[1] || "").split(/^## /m)[0];
  for (const line of sec.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line.replace(/\\\|/g, "\u0000").split("|").map((x) => x.trim());
    const path = cells[1] || "", intent = cells[2] || "";
    if (!/^MODIFY/.test(intent) || path.includes("*")) continue;
    const files = [...path.matchAll(/`([^`]+\.[a-z]+)`/g)].map((x) => x[1]);
    if (files.length === 0) fail(f + ": MODIFY row names no concrete file: " + path);
    for (const file of files) {
      const esc = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const anchored = new RegExp("ocx:" + esc + ":[1-9]\\d*").test(line);
      const inPin = havePinned && existsSync(join(pinned, file));
      if (inPin || (!havePinned && anchored)) {
        if (!anchored) fail(f + ": MODIFY " + file + " has no matching ocx:" + file + ":<line> anchor");
      } else {
        const creator = phaseDocs.filter((g) => g < f).find((g) => new RegExp("\\| `" + file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "`[^|]*\\| NEW").test(read(g)));
        if (!creator) fail(f + ": MODIFY " + file + " is not in the pinned export and no earlier phase creates it");
      }
    }
  }
  for (const m of t.matchAll(/ocx:([\w./@-]+):(\d*)/g)) {
    if (!/^[1-9]\d*$/.test(m[2])) { fail(f + ": anchor without a positive line number: " + m[0]); continue; }
    anchors++;
    if (!havePinned) continue;
    const p = join(pinned, m[1]);
    if (!existsSync(p)) { fail(f + ": anchor file missing in pinned export: " + m[0]); continue; }
    const n = readFileSync(p, "utf8").split("\n").length;
    if (+m[2] < 1 || +m[2] > n) fail(f + ": anchor line out of range: " + m[0]);
  }
}
console.log("phase anchors=" + anchors + (havePinned ? " (resolved against pinned export)" : " (pinned export absent: syntax only)"));

// 4. index.html: exists, offline, relative links resolve
if (!existsSync(join(dir, "index.html"))) fail("missing index.html");
else {
  const h = read("index.html");
  for (const m of h.matchAll(/<(script|link|img|iframe)\b[^>]*(src|href)="(https?:)?\/\/[^"]+"/gi)) fail("index.html loads a network resource: " + m[0].slice(0, 80));
  for (const m of h.matchAll(/href="([^"#]+)(#[^"]*)?"/g)) {
    const t = m[1];
    if (/^(https?:|mailto:)/.test(t)) continue;
    if (!existsSync(resolve(dir, decodeURIComponent(t)))) fail("index.html link target missing: " + t);
  }
  for (const id of rows.keys()) if (!h.includes(id)) fail("index.html does not show " + id);
  for (const d of decades) if (!h.includes(d)) fail("index.html does not show phase " + d);
}

const count = (k) => [...rows.values()].filter((r) => r.phase === k).length;
const adopted = [...rows.values()].filter((r) => /^0\d0$/.test(r.phase)).length;
console.log("gaps=" + rows.size + " adopted=" + adopted + " defer=" + count("DEFER") + " reject=" + count("REJECT") + " closed=" + count("CLOSED") + " phases=" + decades.length + " (" + decades.join(",") + ")");
if (errors.length) { console.error(errors.map((e) => "FAIL " + e).join("\n")); process.exit(1); }
console.log("check.mjs: OK");
