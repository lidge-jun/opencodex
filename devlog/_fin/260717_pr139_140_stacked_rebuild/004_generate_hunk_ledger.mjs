import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UNIT = dirname(fileURLToPath(import.meta.url));
const SOURCES = [
  { pr: "139", head: "d209dfd5dfdf6286c53fafd45d9cb3475696eab8", ref: "codex/wibias-139-dev-rebase" },
  { pr: "140", head: "d92ae93701df289be467db73000e67e28fe9ec61", ref: "codex/wibias-140-dev-rebase" },
];

const clean = (value) => value.replaceAll("\t", " ").replaceAll("\n", " ");
const row = (disposition, childIds, rationale, owningTest) => ({ disposition, childIds, rationale, owningTest });

function classify139(path, ordinal) {
  if (path === ".gitignore" || path === "tests/xai-refresh-lock.test.ts") {
    return row("drop", "-", "Unrelated artifact or xAI test churn; source provenance remains in immutable ref.", "git diff --check");
  }
  if ([220, 221, 222, 223, 234, 241, 242, 255, 256, 257].includes(ordinal)) {
    return row("rewrite", "010", "Exact WP010 contract/NVIDIA hunk; maintainer tests add propagation and free-but-key-required assertions.", "bun test tests/provider-registry-parity.test.ts");
  }
  if ([224, 225, 235, 236, 237, 238, 239, 240, 270, 271].includes(ordinal)) {
    return row("rewrite", "100", "Provider label/note copy hunk is excluded from WP010 and owned by final UI-copy integration.", "bun test tests/provider-registry-parity.test.ts && bun run --cwd gui lint");
  }
  if (["src/providers/quota.ts", "tests/provider-quota.test.ts", "gui/src/codex-quota-utils.ts"].includes(path)) {
    return row("retain", "020", "Provider quota normalization and reset-window contract.", "bun test tests/provider-quota.test.ts tests/rate-limit-reset-credits.test.ts");
  }
  if (["gui/src/provider-workspace-data.ts", "gui/src/provider-icons.ts", "tests/provider-workspace-data.test.ts"].includes(path)) {
    return row("rewrite", "030", "Split pure provider classification, sorting, usage and icon metadata from React rendering.", "bun test tests/provider-workspace-data.test.ts");
  }
  if (["src/server/management-api.ts", "src/server/auth-cors.ts", "src/server/index.ts", "tests/server-auth.test.ts"].includes(path)) {
    return row("rewrite", "040", "Retain provider-management endpoints only after live-connect and API-key-pool blockers are repaired.", "bun test tests/server-auth.test.ts tests/provider-api-keys.test.ts");
  }
  if (path === "gui/src/components/AddProviderModal.tsx") {
    return row("rewrite", "050", "Decompose preset catalog/data from modal rendering; preserve one add-provider behavior per module.", "bun run --cwd gui lint && bun run --cwd gui build");
  }
  if (["gui/src/components/AddCodexAccountModal.tsx", "gui/src/components/CodexAccountPool.tsx"].includes(path)) {
    return row("rewrite", "060", "Embed Codex account management without duplicating OAuth/account state owners.", "bun run --cwd gui lint && bun run --cwd gui build");
  }
  if (["gui/src/components/QuotaBars.tsx", "tests/rate-limit-reset-credits.test.ts"].includes(path)) {
    return row("rewrite", "070", "Build bounded quota rows and usage rendering on the phase-020 contract.", "bun test tests/rate-limit-reset-credits.test.ts && bun run --cwd gui build");
  }
  if (path === "gui/src/App.tsx" || path === "gui/src/icons.tsx") {
    return row("rewrite", "080", "Introduce workspace route, navigation and rail shell only.", "bun run --cwd gui lint && bun run --cwd gui build");
  }
  if (path === "gui/src/components/ProviderWorkspace.tsx") {
    return row("rewrite-fanout", "003/PW", "Indivisible source hunk is accounted only by the symbol sub-ledger; the parent receives no child credit.", "bun run --cwd gui lint && bun run --cwd gui build");
  }
  if (path === "gui/src/pages/Providers.tsx") {
    if (ordinal >= 164 && ordinal <= 169) return row("rewrite", "080", "Imports, route props and workspace shell ownership.", "bun run --cwd gui lint && bun run --cwd gui build");
    if (ordinal >= 170 && ordinal <= 180) return row("rewrite", "040", "Provider config/quota/API orchestration state and fetch ownership.", "bun test tests/provider-connection-test.test.ts tests/provider-api-keys.test.ts");
    if (ordinal >= 181 && ordinal <= 197) return row("rewrite", "060", "Account/key/OAuth orchestration ownership.", "bun run --cwd gui lint && bun run --cwd gui build");
    if (ordinal === 198) return row("rewrite", "040", "Provider update mutation adapter owned by the management API child.", "bun test tests/provider-connection-test.test.ts tests/provider-api-keys.test.ts");
    if (ordinal >= 199 && ordinal <= 202) return row("rewrite", "080", "Workspace loading/composition shell ownership.", "bun run --cwd gui lint && bun run --cwd gui build");
    if (ordinal === 203) return row("rewrite", "050", "Add-provider modal composition ownership.", "bun test tests/provider-workspace-data.test.ts && bun run --cwd gui build");
    if (ordinal === 204) return row("rewrite", "080", "Workspace shell close/render boundary.", "bun run --cwd gui lint && bun run --cwd gui build");
    throw new Error(`Unclassified PR139 Providers hunk: ${ordinal}`);
  }
  if (path.startsWith("gui/src/i18n/")) {
    if ([121, 134, 147, 160].includes(ordinal)) return row("rewrite-fanout", "003/LOCALE", "Large mixed locale hunk is accounted only by the key-prefix sub-ledger.", "bun run --cwd gui lint");
    return row("rewrite", "100", "Ordinary locale/copy hunk has one final integration owner.", "bun run --cwd gui lint");
  }
  if (path === "gui/src/styles-provider-workspace.css") {
    return row("rewrite-fanout", "003/CSS", "Indivisible stylesheet hunk is accounted only by the selector-family sub-ledger.", "bun run --cwd gui lint && bun run --cwd gui build");
  }
  if (["gui/src/styles.css", "gui/package.json"].includes(path)) {
    return row("rewrite", "100", "Global style/lint integration has one owner after component-scoped styles land.", "bun run --cwd gui lint && bun run --cwd gui build");
  }
  throw new Error(`Unclassified PR139 path: ${path}`);
}

const TOOLING_140 = new Set([
  ".github/workflows/react-doctor.yml", "gui/README.md", "gui/bun.lock", "gui/doctor.config.json",
  "gui/eslint.config.js", "gui/package.json", "package.json", "scripts/doctor-gui-if-changed.ts", "scripts/setup-hooks.ts",
]);
const FOUNDATION_140 = new Set([
  "gui/src/App.tsx", "gui/src/api.ts", "gui/src/main.tsx", "gui/src/i18n/provider.tsx",
  "gui/src/components/AddCodexAccountModal.tsx", "gui/src/components/AddProviderModal.tsx", "src/codex/auth-api.ts",
]);
const PROVIDER_MODELS_140 = new Set([
  "gui/src/pages/Providers.tsx", "gui/src/pages/Models.tsx", "gui/src/components/QuotaBars.tsx",
  "gui/src/model-display.ts", "src/codex/catalog.ts", "src/providers/derive.ts", "src/server/management-api.ts", "src/types.ts",
]);
function classify140(path, ordinal) {
  if (TOOLING_140.has(path)) return row("rewrite", "110", "Pin React Doctor package/action and keep checks advisory with least privilege.", "bun test tests/ci-workflows.test.ts && bun run doctor:gui");
  if (FOUNDATION_140.has(path)) return row("rewrite", "120", "Retain query/client and modal accessibility foundations after #139 UI owners exist.", "bun run --cwd gui lint && bun run --cwd gui build");
  if (PROVIDER_MODELS_140.has(path)) return row("rewrite", "130", "Reapply validated provider/model diagnostics atop the completed #139 stack; never take the conflicting file wholesale.", "bun run --cwd gui lint && bun run --cwd gui build");
  if (path === "gui/src/pages/Dashboard.tsx") return row("rewrite", "140", "Dashboard query/render diagnostics only.", "bun run --cwd gui lint && bun run --cwd gui build");
  if (path === "gui/src/pages/Usage.tsx") return row("rewrite", "141", "Usage query/render diagnostics only.", "bun run --cwd gui lint && bun run --cwd gui build");
  if (path === "gui/src/pages/ClaudeCode.tsx") return row("rewrite", "150", "ClaudeCode page-local diagnostics only.", "bun run --cwd gui lint && bun run --cwd gui build");
  if (path === "gui/src/pages/Debug.tsx") return row("rewrite", "151", "Debug page-local diagnostics only.", "bun run --cwd gui lint && bun run --cwd gui build");
  if (path === "gui/src/pages/Logs.tsx") return row("rewrite", "152", "Logs page-local diagnostics only.", "bun run --cwd gui lint && bun run --cwd gui build");
  if (["gui/src/pages/ApiKeys.tsx", "gui/src/pages/CodexAuth.tsx", "tests/desktop-3p.test.ts"].includes(path)) return row("rewrite", "153", "Auth/key page-local diagnostics only.", "bun test tests/desktop-3p.test.ts && bun run --cwd gui build");
  if (path === "gui/src/pages/Subagents.tsx") return row("rewrite", "154", "Subagents page-local diagnostics only.", "bun run --cwd gui lint && bun run --cwd gui build");
  if (path === "gui/src/styles.css" && ordinal === 391) return row("rewrite", "140", "Dashboard info-button and mode-toggle selectors have one Dashboard owner.", "bun run --cwd gui build");
  if (path === "gui/src/styles.css" && ordinal === 392) return row("rewrite", "120", "Shared dialog.modal-overlay foundation has one modal-foundation owner.", "bun run --cwd gui build");
  if (path === "gui/src/styles.css" && ordinal === 393) return row("rewrite-fanout", "003/140-CSS", "Mixed utility hunk is accounted by its three real selector/consumer groups only.", "bun run --cwd gui build");
  if (["src/update/index.ts", "src/update/job.ts"].includes(path)) return row("rewrite", "160", "Verify and install one immutable version; preserve unavailable-version best effort with regression tests.", "bun test tests/update*.test.ts");
  if (path === "src/adapters/anthropic-image-normalize.ts") return row("rewrite", "170", "Retain image normalization changes only with an explicit concurrency bound and activation test.", "bun test tests/anthropic-image*.test.ts");
  if (path === "src/adapters/cursor/transport-retry.ts") return row("rewrite", "180", "Close failed transport before constructing/running the retry; add order assertion.", "bun test tests/cursor*transport*.test.ts");
  if (ordinal === 488 && path === "tests/xai-refresh-lock.test.ts") return row("drop", "-", "Valid Windows xAI flake stabilization, deliberately out of this provider-workspace/Doctor stack and preserved in the immutable source ref.", "immutable source ref + tests/xai-refresh-lock.test.ts");
  return row("drop", "-", "Unrelated React-Doctor mechanical backend churn has no isolated consumer or regression proof in the reviewed PR.", "immutable source ref + hunk ledger");
}

const out = ["id\tsource_pr\tsource_head\tpath\thunk_header\tdisposition\tchild_ids\trationale\towning_test"];
const counts = {};
for (const source of SOURCES) {
  const diff = execFileSync("git", ["diff", "--unified=0", "--no-color", `origin/dev...${source.ref}`], { encoding: "utf8" });
  let path = "";
  let ordinal = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) path = line.slice(6);
    if (!line.startsWith("@@")) continue;
    ordinal += 1;
    const c = source.pr === "139" ? classify139(path, ordinal) : classify140(path, ordinal);
    const id = `${source.pr}-H${String(ordinal).padStart(3, "0")}`;
    out.push([id, source.pr, source.head, path, line, c.disposition, c.childIds, c.rationale, c.owningTest].map(clean).join("\t"));
    counts[`${source.pr}:${c.disposition}`] = (counts[`${source.pr}:${c.disposition}`] ?? 0) + 1;
  }
  const expected = source.pr === "139" ? 276 : 488;
  if (ordinal !== expected) throw new Error(`PR${source.pr} expected ${expected} hunks, got ${ordinal}`);
}
writeFileSync(join(UNIT, "001_hunk_ledger.tsv"), `${out.join("\n")}\n`);
const fanout = [
  "parent_id\tsub_id\tsymbol_or_selector\tchild_id\tdisposition\trationale",
  "139-H090\tPW-01\tshared types + status/icon helpers\t080\trewrite\tshell contracts",
  "139-H090\tPW-02\tRailRow + EmptyState + OverviewPanel shell\t080\trewrite\trail and shell",
  "139-H090\tPW-03\tConnectionCard + StatsSidebar + TabOverview + TabModels + TabUsage\t090\trewrite\toverview/model/usage panels",
  "139-H090\tPW-04\tAuthAccountsCard + TabSettings + JsonEditorPanel + dialogs\t091\trewrite\tauth/settings/json panels",
  "139-H209\tCSS-01\tadd-provider catalog selectors\t050\trewrite\tprovider-catalog.css",
  "139-H209\tCSS-02\taccount/auth selectors\t060\trewrite\tprovider-accounts.css",
  "139-H209\tCSS-03\tquota/usage selectors\t070\trewrite\tprovider-quota.css",
  "139-H209\tCSS-04\troot/rail/search/filter selectors\t080\trewrite\tprovider-workspace-shell.css",
  "139-H209\tCSS-05\toverview/models/usage detail selectors\t090\trewrite\tprovider-workspace-detail.css",
  "139-H209\tCSS-06\tauth/settings/json/dialog selectors\t091\trewrite\tprovider-workspace-settings.css",
  "139-H209\tCSS-07\tresponsive consolidation + legacy deletion\t100\trewrite\tfinal integration",
  ...["139-H121", "139-H134", "139-H147", "139-H160"].flatMap((parent) => [
    `${parent}\tLOCALE-01\tadd-provider catalog keys\t050\trewrite\tconsumer-owned keys`,
    `${parent}\tLOCALE-02\taccount/auth keys\t060\trewrite\tconsumer-owned keys`,
    `${parent}\tLOCALE-03\tquota/usage keys\t070\trewrite\tconsumer-owned keys`,
    `${parent}\tLOCALE-04\tworkspace shell/rail keys\t080\trewrite\tconsumer-owned keys`,
    `${parent}\tLOCALE-05\toverview/models/usage keys\t090\trewrite\tconsumer-owned keys`,
    `${parent}\tLOCALE-06\tsettings/json/dialog keys\t091\trewrite\tconsumer-owned keys`,
    `${parent}\tLOCALE-07\tcopy normalization/unused-key deletion\t100\trewrite\tfinal parity cleanup`,
  ]),
  "140-H393\t140-CSS-01\tcard-selectable + card-select-hit\t153\trewrite\tCodexAuth/account consumer",
  "140-H393\t140-CSS-02\tmodal-card/input/list/notice/button/spinner utilities\t120\trewrite\tAddCodexAccountModal consumer",
  "140-H393\t140-CSS-03\thelp-popup selectors\t140\trewrite\tDashboard consumer",
];
writeFileSync(join(UNIT, "001_hunk_fanout.tsv"), `${fanout.join("\n")}\n`);
console.log(JSON.stringify({ rows: out.length - 1, fanoutRows: fanout.length - 1, counts }, null, 2));
