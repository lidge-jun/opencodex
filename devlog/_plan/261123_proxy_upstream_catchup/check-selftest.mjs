#!/usr/bin/env node
// Regression cases for check.mjs: copies this unit to a temp dir, injects one defect per case,
// and asserts check.mjs exits as expected. Usage: node check-selftest.mjs
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const dir = dirname(fileURLToPath(import.meta.url));
const pinned = resolve(dir, "../../../.tmp/chase/opencodex-dev");
const cases = [
  { name: "baseline passes", expect: 0, edit: () => {} },
  { name: "anchor without line number fails", expect: 1, edit: (d) => sub(d, "080_observability.md", "ocx:src/cli/claude.ts:849", "ocx:src/cli/claude.ts:") },
  { name: "pin absent + earlier NEW creator passes", expect: 0, pin: false, edit: () => {} },
  { name: "pin absent + creator removed fails", expect: 1, pin: false, edit: (d) => sub(d, "070_shared_proxy_governance.md", "| \x60src/server/key-admission.ts\x60 | NEW", "| \x60src/server/key-admission-x.ts\x60 | NEW") },
  { name: "dependency mismatch fails", expect: 1, edit: (d) => sub(d, "060_wire_fidelity.md", "**Depends on:** 040", "**Depends on:** none") },
  { name: "adopted gap missing from phase doc fails", expect: 1, edit: (d) => sub(d, "040_pool_scheduling_egress.md", "**Gaps:** G-012, ", "**Gaps:** ") },
  { name: "non-adopted id in phase doc fails", expect: 1, edit: (d) => sub(d, "090_request_policy.md", "**Gaps:** G-034, G-035", "**Gaps:** G-034, G-035, G-059") },
  { name: "network resource in html fails", expect: 1, edit: (d) => sub(d, "index.html", "</head>", "<script src=\"https://cdn.example/x.js\"></script></head>") },
  { name: "phase doc without before/after sketch fails", expect: 1, edit: (d) => sub(d, "060_wire_fidelity.md", "// before\nexport function checkRepresentable", "export function checkRepresentable") },
  { name: "MODIFY row without anchor fails", expect: 1, edit: (d) => sub(d, "040_pool_scheduling_egress.md", "(\x60ocx:src/server/messages-native-oauth.ts:120\x60)", "") },
];
function sub(d, file, a, b) {
  const p = join(d, file);
  const t = readFileSync(p, "utf8");
  if (!t.includes(a)) throw new Error("selftest anchor missing in " + file + ": " + a);
  writeFileSync(p, t.split(a).join(b));
}
let bad = 0;
for (const c of cases) {
  const root = mkdtempSync(join(tmpdir(), "ocx-catchup-check-"));
  const d = join(root, "unit");
  cpSync(dir, d, { recursive: true });
  let src = readFileSync(join(d, "check.mjs"), "utf8");
  const target = c.pin === false ? join(root, "no-such-pin") : pinned;
  src = src.replace('resolve(dir, "../../../.tmp/chase/opencodex-dev")', JSON.stringify(target));
  writeFileSync(join(d, "check.mjs"), src);
  c.edit(d);
  const r = spawnSync(process.execPath, [join(d, "check.mjs")], { encoding: "utf8" });
  const ok = r.status === c.expect;
  if (!ok) bad++;
  console.log((ok ? "ok   " : "FAIL ") + c.name + " (exit " + r.status + ", expected " + c.expect + ")" + (ok ? "" : "\n" + r.stdout + r.stderr));
}
if (!existsSync(pinned)) console.log("note: pinned export absent; pin-present cases ran against a missing path");
process.exit(bad ? 1 : 0);
