// Best-effort inventory/lint of known patterns, not a security boundary or
// completeness proof. Runtime mutation guards enforce update authority.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { repoPath, repoRoot } from "./repo-root";
import { compact, files, rawMutationViolations, updateModuleFiles } from "./update-mutation-scanner";
import { capabilityPolicy } from "./update-capability-policy";

// Share the known acquisition patterns with the auxiliary scanner.
export function capabilityControlCalls(source: ts.SourceFile, file = ""): ts.CallExpression[] {
  const policy = capabilityPolicy(source, file), calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      let sensitive = false;
      const inspect = (part: ts.Node) => {
        if (ts.isArrowFunction(part) || ts.isFunctionExpression(part)) return;
        if (policy.reason(part)) sensitive = true;
        part.forEachChild(inspect);
      };
      inspect(node.expression);
      for (const argument of node.arguments) inspect(argument);
      if (policy.reason(node)) sensitive = true;
      if (sensitive) calls.push(node);
    }
    node.forEachChild(visit);
  };
  visit(source); return calls;
}

export function helperControlInventory(parser?: API) {
  const launcher = readFileSync(repoPath("bin/ocx.mjs"), "utf8");
  const imports = [...launcher.matchAll(/from\s+"(\.\.\/src\/[^\"]+)"/g)].map(m =>
    relative(repoRoot(), resolve(dirname(repoPath("bin/ocx.mjs")), m[1])).replaceAll("\\", "/"));
  const helpers = [...new Set([
    ...updateModuleFiles(),
    ...imports,
  ])].filter(f => !files.includes(f)).sort();
  const nativeHelper = "src/update/npm-install-job.ps1";
  const policyFiles = ["bin/ocx.mjs", ...updateModuleFiles()];
  const api = parser ?? new API(), snapshot = api.updateSnapshot({ openFiles: [...new Set([...helpers, ...policyFiles])].map(f => repoPath(f)) });
  const policyViolations: string[] = [];
  const sites: { file: string; context: string; call: string; line: number }[] = [];
  try {
    // Include launcher/primary modules as well as helper dispatch sites. A root
    // escape or unreviewed import is inventoried even when it makes no call yet.
    for (const file of policyFiles) {
      const source = snapshot.getDefaultProjectForFile(repoPath(file))!.program.getSourceFile(repoPath(file))!;
      policyViolations.push(...rawMutationViolations(source, file).map(reason => file + ": " + reason));
    }
    for (const file of helpers) {
      const source = snapshot.getDefaultProjectForFile(repoPath(file))!.program.getSourceFile(repoPath(file))!;
      const capabilityCalls = new Set(file.startsWith("src/update/") && !/\/(?:mutation-guard\.mjs|guarded-runtime-ops\.ts|guarded-tray-ops\.ts)$/.test(file)
        ? capabilityControlCalls(source, file) : []);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && !["spawnFailure", "registrySpawnTarget"].includes(compact(node.expression))
          && !(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "trim")
          && (capabilityCalls.has(node) || /[sS]pawn|execFile|guardedRun|guardedRename|guardedKill|guardedExecFile|ownedArtifact|^native$|^operation$|(?:^|\.)kill$|^run$|^runPnpm$|^io\.(?:stop|start)$|^(?:removePid|removeRuntimePort|dropWindowsTcpRowsForLocalPort|stopWinswService|stopWindows|killWindowsSchedulerWrappers|stopWindowsTray)$|(?:^|\.)(?:rename(?:WithRetry)?|rm|unlink|writeFile|copyFile)(?:Sync)?$/.test(compact(node.expression)))) {
          let context = "<module>";
          for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
            if (ts.isFunctionDeclaration(p) && p.name) { context = p.name.text; break; }
          }
          sites.push({ file, context, call: compact(node), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
  } finally { snapshot.dispose(); if (!parser) api.close(); }
  // The launcher's Windows staging supervisor embeds C#, outside the TS parser.
  // Only executable call lines count; native declarations confer no authority.
  readFileSync(repoPath(nativeHelper), "utf8").split(/\r?\n/).forEach((line, index) => {
    if (!line.includes("extern ") && /\b(?:CreateProcess\w*|Terminate\w*)\s*\(|\b(?:Start|Stop)-Process\b|\b(?:Remove|Move|Copy)-Item\b/.test(line))
      sites.push({ file: nativeHelper, context: "native installer job", call: line.trim(), line: index + 1 });
  });
  return { helpers: [...helpers, nativeHelper], sites, policyViolations };
}
