// Best-effort regression lint over known syntax patterns, not a security boundary
// or completeness proof. Runtime mutation guards enforce update authority.
import * as ts from "typescript/unstable/ast";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "./repo-root";
import { updatePrimitiveAllowlist } from "./update-primitive-allowlist";
import { capabilityPolicy } from "./update-capability-policy";
import { updateProcessAllowlist } from "./update-process-allowlist";

const files = ["bin/ocx.mjs", "src/update/index.ts", "src/update/job.ts", "src/update/job-update-tray.ts",
  "src/update/job-supervised-restart.ts", "src/update/job-pinned-start.ts", "src/update/job-windows-restart.ts"];
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, " ");

export function updateModuleFiles(root = repoPath("src/update"), prefix = "src/update"): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? updateModuleFiles(join(root, entry.name), prefix + "/" + entry.name)
    : /\.(?:ts|mts|mjs|js)$/.test(entry.name) && !/\.d\.(?:ts|mts)$/.test(entry.name) ? [prefix + "/" + entry.name] : []).sort();
}

// These exemptions support the known-pattern lint; they do not establish that
// all possible JavaScript capability acquisition or effect sites are covered.
const boundaryModules = new Set(["src/update/mutation-guard.mjs", "src/update/guarded-runtime-ops.ts", "src/update/guarded-tray-ops.ts"]);
// Additional familiar legacy/injected helper references for regression detection.
const rawNames = new Set(["$", "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "kill", "killProxy", "removePid", "removeRuntimePort",
  "fork", "Worker", "terminate", "write", "writeFile", "writeFileSync", "appendFile", "appendFileSync", "copyFile", "copyFileSync", "truncate", "truncateSync", "symlink", "symlinkSync", "link", "linkSync", "rmdir", "rmdirSync",
  "probeSpawn", "probeSpawnSync", "dropWindowsTcpRowsForLocalPort", "stopWindowsTray", "startWindowsTray", "stopWindows", "stopWinswService", "killWindowsSchedulerWrappers", "renameSync", "rmSync", "unlinkSync"]);
export function contextOf(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent)
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
  return "<module>";
}
// Pinned non-control operations and exact child cleanup are documented in the
// helper inventory. This table contains complete expressions and occurrence counts,
// not expression grammars or prefixes. Adding a row requires boundary review.
export const rawReferenceAllowlist = new Map([...updatePrimitiveAllowlist, ...updateProcessAllowlist.map(([key, reason]) => [key, reason] as const)]);
const occurrenceLimits = new Map([
  ...updateProcessAllowlist.map(([key, , count]) => [key, count] as const),
  ["src/update/async-check.ts:latestVersionAsync:child.kill()", 2],
  ["src/update/npm-install.mjs:runNpmInstall:child.kill()", 2],
  ["src/update/job-pinned-start.ts:spawnWorkerPinnedStart:closeSync(logFd)", 2],
]);
export function rawMutationViolations(source: ts.SourceFile, file: string): string[] {
  const failures: string[] = [];
  const policy = capabilityPolicy(source, file);
  const seen = new Map<string, number>();
  const allowed = (node: ts.Node) => {
    const key = file + ":" + contextOf(node) + ":" + compact(node);
    if (!rawReferenceAllowlist.has(key)) return false;
    const count = (seen.get(key) ?? 0) + 1; seen.set(key, count);
    if (count > (occurrenceLimits.get(key) ?? 1)) { failures.push("extra allowlisted capability occurrence: " + compact(node)); return false; }
    return true;
  };
  const visit = (node: ts.Node) => {
    if ([ts.SyntaxKind.TypeQuery, ts.SyntaxKind.TypeReference, ts.SyntaxKind.TypeLiteral, ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration].includes(node.kind)) return;
    if (ts.isCallExpression(node) && file === "bin/ocx.mjs" && contextOf(node) === "runPackageManagerSelfUpdate"
      && compact(node.expression) === "process.exit" && node.pos > source.text.indexOf("const homePolicy")
      && compact(node.arguments[0]) !== "1") failures.push("unguarded successful update exit: " + compact(node));
    // Dependency admission applies even to trusted primitive implementations and
    // exact legacy exemptions; an exemption cannot open a new import edge.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const admission = policy.reason(node);
      if (admission === "unreviewed static dependency or binding") failures.push(admission + ": " + compact(node));
    }
    if (boundaryModules.has(file)) {
      if (policy.trustedRootSite(node)) return;
      if (policy.rootViolation(node)) failures.push("forbidden wrapper capability root: " + compact(node));
      node.forEachChild(visit); return;
    }
    if (allowed(node)) return;
    const capability = policy.reason(node);
    if (capability) failures.push(capability + ": " + compact(node));
    if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
      const module = node.moduleSpecifier.getText().slice(1,-1);
      if (/^(?:node:)?(?:child_process|process)$/.test(module)) failures.push("raw process import: " + compact(node));
      const bindings = node.importClause.namedBindings;
      if (module === "bun" && (node.importClause.name || bindings && ts.isNamespaceImport(bindings)))
        failures.push("raw Bun runtime import: " + compact(node));
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
        if (/mutation-guard\.mjs$/.test(module) && /^probeSpawn(?:Sync)?$/.test(binding.name.text) && !binding.propertyName) continue;
        if (!binding.isTypeOnly && (rawNames.has((binding.propertyName ?? binding.name).text) || ["rm", "unlink", "rename"].includes((binding.propertyName ?? binding.name).text)))
          failures.push("raw primitive import/alias: " + compact(node));
      }
      if (bindings && ts.isNamespaceImport(bindings) && /(?:^node:)?fs(?:\/promises)?$/.test(module))
        failures.push("raw filesystem namespace: " + compact(node));
      if (node.importClause.name && /(?:^node:)?fs(?:\/promises)?$/.test(module)) failures.push("raw filesystem default import: " + compact(node));
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly)
      if (/^["'](?:bun|(?:node:)?(?:child_process|process|fs(?:\/promises)?))["']$/.test(node.moduleSpecifier.getText())
        || !node.exportClause || ts.isNamedExports(node.exportClause) && node.exportClause.elements.some(e=>rawNames.has((e.propertyName ?? e.name).text))) failures.push("raw primitive re-export: " + compact(node));
    if (node.kind === ts.SyntaxKind.ImportEqualsDeclaration && /["'](?:bun|(?:node:)?(?:child_process|process|fs(?:\/promises)?))["']/.test(compact(node))) failures.push("raw primitive require import: " + compact(node));
    if (ts.isTaggedTemplateExpression(node)) failures.push("raw tagged-template execution: " + compact(node));
    if (ts.isCallExpression(node)) {
      const name = compact(node.expression), text = compact(node);
      if (name === "console.log" && /Updated|✅|[Pp]roxy is healthy/.test(text) || name === "updateJob" && text.includes('status: "succeeded"'))
        failures.push("unguarded success publication: " + text);
    }
    if (ts.isCallExpression(node) && ["require", "import"].includes(compact(node.expression)) && node.arguments.some(arg=>/^(?:["'])(?:bun|(?:node:)?(?:child_process|process|fs(?:\/promises)?))["']$/.test(compact(arg))))
      failures.push("raw primitive module load: " + compact(node));
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
      && (rawNames.has(node.argumentExpression.text) || ["kill", "rm", "unlink", "rename"].includes(node.argumentExpression.text))) failures.push("computed raw primitive reference: " + compact(node));
    if (ts.isPropertyAccessExpression(node) && node.expression.kind !== ts.SyntaxKind.RegularExpressionLiteral
      && (["kill", "rm", "unlink", "rename", "rmSync", "unlinkSync", "renameSync"].includes(node.name.text) || rawNames.has(node.name.text)))
      failures.push("raw primitive reference: " + compact(node));
    if (ts.isIdentifier(node) && rawNames.has(node.text)) {
      const parent=node.parent;
      const isName = ts.isPropertyAccessExpression(parent) && parent.name === node || ts.isPropertyAssignment(parent) && parent.name === node
        || ts.isFunctionDeclaration(parent) && parent.name === node || parent.kind === ts.SyntaxKind.Parameter && (parent as ts.ParameterDeclaration).name === node;
      if (!isName) failures.push("raw primitive reference: " + node.text);
    }
    if (ts.isIdentifier(node) && node.text === "process" && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
      && !(ts.isTypeOfExpression(node.parent))) failures.push("raw process object reference: " + compact(node.parent));
    if (ts.isIdentifier(node) && node.text === "Bun" && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node))
      failures.push("raw Bun object reference: " + compact(node.parent));
    node.forEachChild(visit);
  };
  visit(source); return failures;
}
export { files, compact };
