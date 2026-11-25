#!/usr/bin/env node
// Builds index.html from 009_gap_matrix.md and the 0X0 phase docs. No network, no deps.
// Usage: node build_index.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(dir, f), "utf8");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const md = (s) => esc(s).replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

const matrix = read("009_gap_matrix.md");
let header = null;
const rows = [];
for (const line of matrix.split("\n")) {
  if (!header && /^\|\s*ID\s*\|/.test(line)) header = line.split("|").slice(1, -1).map((c) => c.trim());
  const m = line.match(/^\|\s*(G-\d{3})\s*\|/);
  if (m) { const c = line.split("|").slice(1, -1).map((x) => x.trim()); if (c.length >= 7) rows.push(c); }
}
const phaseCol = header ? header.length - 1 : 7;

const phases = readdirSync(dir).filter((f) => /^0[1-9]0_.*\.md$/.test(f)).sort().map((f) => {
  const t = read(f);
  const title = (t.match(/^#\s+(.*)$/m) || [, f])[1];
  const gaps = ((t.match(/^\*\*Gaps:\*\*(.*)$/m) || [, ""])[1].match(/G-\d{3}/g)) || [];
  const dep = ((t.match(/^\*\*Depends on:\*\*(.*)$/m) || [, "—"])[1]).trim();
  const size = ((t.match(/^\*\*Size:\*\*(.*)$/m) || [, ""])[1]).trim();
  const goal = ((t.split(/^## Goal\s*$/m)[1] || "").trim().split(/\n\s*\n/)[0] || "").replace(/\n/g, " ");
  return { f, id: f.slice(0, 3), title, gaps, dep, size, goal };
});
const research = readdirSync(dir).filter((f) => /^00\d_.*\.md$/.test(f)).sort();

const counts = { total: rows.length, adopted: rows.filter((r) => /^0\d0$/.test(r[phaseCol].replace(/[\x60*]/g, ""))).length };
const ph = (r) => r[phaseCol].replace(/[\x60*]/g, "");
counts.defer = rows.filter((r) => ph(r) === "DEFER").length;
counts.reject = rows.filter((r) => ph(r) === "REJECT").length;
counts.closed = rows.filter((r) => ph(r) === "CLOSED").length;

const vClass = (v) => (/high|높/i.test(v) ? "hi" : /med|중/i.test(v) ? "md" : "lo");
const html = '<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>OpenCodex upstream catch-up roadmap</title><style>' +
':root{--bg:#0f1115;--card:#171a21;--ink:#e6e8ee;--mut:#9aa3b2;--line:#2a2f3a;--acc:#6cb6ff;--hi:#ff7b72;--md:#e3b341;--lo:#7ee787}' +
'@media (prefers-color-scheme:light){:root{--bg:#f7f8fa;--card:#fff;--ink:#1f2328;--mut:#59636e;--line:#d1d9e0;--acc:#0969da;--hi:#cf222e;--md:#9a6700;--lo:#1a7f37}}' +
'*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}' +
'main{max-width:1280px;margin:0 auto;padding:24px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}.mut{color:var(--mut)}' +
'a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}code{font:12px ui-monospace,Menlo,monospace;background:var(--line);padding:1px 4px;border-radius:4px}' +
'.stats{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}.stat b{display:block;font-size:22px}' +
'.timeline{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}.ph{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;position:relative}' +
'.ph .n{font:600 12px ui-monospace,Menlo,monospace;color:var(--acc)}.ph h3{font-size:14px;margin:4px 0 6px}.ph p{margin:6px 0;font-size:13px}.chips{display:flex;flex-wrap:wrap;gap:4px}' +
'.chip{font:11px ui-monospace,Menlo,monospace;border:1px solid var(--line);border-radius:999px;padding:1px 7px;cursor:pointer;background:transparent;color:var(--ink)}' +
'.tools{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}input,select{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px 8px}' +
'table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}th,td{text-align:left;vertical-align:top;padding:7px 9px;border-bottom:1px solid var(--line)}' +
'#t td:first-child,#t th:first-child{white-space:nowrap}th{position:sticky;top:0;background:var(--card);cursor:pointer;user-select:none}tr.flash td{background:color-mix(in srgb,var(--acc) 18%,transparent)}' +
'.v{font-weight:600}.v.hi{color:var(--hi)}.v.md{color:var(--md)}.v.lo{color:var(--lo)}.rej{opacity:.6}ul.docs{columns:2;padding-left:18px}' +
'</style></head><body><main>' +
'<h1>OpenCodex upstream catch-up roadmap</h1><div class="mut">CLIProxyAPI · cc-switch · sub2api · magpie 대비 부족한 점과 단계별 따라잡기 · generated from <a href="009_gap_matrix.md">009_gap_matrix.md</a> by <code>build_index.mjs</code></div>' +
'<div class="stats"><div class="stat"><b>' + counts.total + '</b>gaps</div><div class="stat"><b>' + counts.adopted + '</b>adopted</div><div class="stat"><b>' + counts.defer + '</b>deferred</div><div class="stat"><b>' + counts.reject + '</b>rejected</div><div class="stat"><b>' + counts.closed + '</b>already in OpenCodex</div><div class="stat"><b>' + phases.length + '</b>phases</div></div>' +
'<h2>Phase timeline</h2><div class="timeline">' + phases.map((p) =>
  '<div class="ph"><div class="n">' + p.id + (p.size ? ' · ' + esc(p.size) : '') + '</div><h3><a href="' + esc(p.f) + '">' + md(p.title.replace(/^0\d0\s*[—-]\s*/, "")) + '</a></h3>' +
  '<p class="mut">depends on: ' + md(p.dep) + '</p><p>' + md(p.goal.slice(0, 320)) + '</p><div class="chips">' + p.gaps.map((g) => '<button class="chip" data-g="' + g + '">' + g + '</button>').join("") + '</div></div>').join("") + '</div>' +
'<h2>Gap matrix</h2><div class="tools"><input id="q" placeholder="filter (id, CAP, text, source)…" size="40"><select id="ph"><option value="">all phases</option>' +
  phases.map((p) => '<option>' + p.id + '</option>').join("") + '<option>DEFER</option><option>REJECT</option><option>CLOSED</option></select></div>' +
'<table id="t"><thead><tr>' + (header || []).map((h, i) => '<th data-i="' + i + '">' + esc(h) + '</th>').join("") + '</tr></thead><tbody>' +
  rows.map((r) => { const ph = r[phaseCol].replace(/[\x60*]/g, ""); return '<tr id="' + r[0] + '" data-ph="' + esc(ph) + '"' + (/^0\d0$/.test(ph) ? "" : ' class="rej"') + '>' +
    r.map((c, i) => { if (i === phaseCol && /^0\d0$/.test(ph)) { const p = phases.find((x) => x.id === ph); return '<td><a href="' + esc(p ? p.f : "#") + '">' + ph + '</a></td>'; }
      if (header && /가치|value/i.test(header[i] || "")) return '<td class="v ' + vClass(c) + '">' + md(c) + '</td>'; return '<td>' + md(c) + '</td>'; }).join("") + '</tr>'; }).join("") +
'</tbody></table>' +
'<h2>Research documents</h2><ul class="docs">' + research.map((f) => '<li><a href="' + esc(f) + '">' + esc(f) + '</a></li>').join("") + '</ul>' +
'</main><script>' +
'const q=document.getElementById("q"),ph=document.getElementById("ph"),rows=[...document.querySelectorAll("#t tbody tr")];' +
'function f(){const s=q.value.toLowerCase(),p=ph.value;rows.forEach(r=>{r.style.display=(!s||r.textContent.toLowerCase().includes(s))&&(!p||r.dataset.ph===p)?"":"none"})}q.oninput=f;ph.onchange=f;' +
'document.querySelectorAll(".chip").forEach(c=>c.onclick=()=>{q.value="";ph.value="";f();const r=document.getElementById(c.dataset.g);if(r){r.scrollIntoView({block:"center"});r.classList.add("flash");setTimeout(()=>r.classList.remove("flash"),1600)}});' +
'document.querySelectorAll("#t th").forEach(th=>th.onclick=()=>{const i=+th.dataset.i,b=document.querySelector("#t tbody"),d=th.dataset.d=th.dataset.d==="1"?"-1":"1";[...b.rows].sort((a,c)=>a.cells[i].textContent.localeCompare(c.cells[i].textContent,"ko",{numeric:true})*d).forEach(r=>b.appendChild(r))});' +
'</script></body></html>\n';
writeFileSync(join(dir, "index.html"), html);
console.log("index.html: " + rows.length + " gaps, " + phases.length + " phases");
