// Best-effort regression lint over known acquisition patterns, not a security
// boundary or completeness proof. Runtime mutation guards enforce authority.
import * as ts from "typescript/unstable/ast";
import { updateBoundaryRootSites, updateDeferredImports, updateStaticImports } from "./update-import-policy";
import { updatePrimitiveAllowlist } from "./update-primitive-allowlist";
import { updateProcessAllowlist } from "./update-process-allowlist";

// Known-pattern acquisition lint: unfamiliar runtime API names are flagged by default.
// Opening files is deliberately excluded: even a read-mode open returns a mutable
// FileHandle/fd. Ban acquisition rather than trying to follow every later alias.
const fsReads = new Set(["access", "accessSync", "constants", "existsSync", "lstat", "lstatSync",
  "stat", "statSync", "fstat", "fstatSync", "readFile", "readFileSync", "readdir", "readdirSync",
  "readlink", "readlinkSync", "realpath", "realpathSync"]);
const bunReads = new Set(["sleep", "sleepSync", "version", "revision", "which", "semver", "env"]);
const processReads = new Set(["env", "argv", "execPath", "platform", "arch", "pid", "ppid", "versions",
  "version", "cwd", "getuid", "geteuid", "exitCode"]);
// These modules expose data/formatting/timing utilities, not runtime controls.
const utilityModules = new Set(["path", "path/posix", "path/win32", "url", "util", "util/types",
  "buffer", "events", "assert", "assert/strict", "timers", "timers/promises", "string_decoder"]);
const readsFor = (module: string): Set<string> | undefined => {
  module = module.replace(/^node:/, "");
  if (module === "fs" || module === "fs/promises") return fsReads;
  if (module === "bun") return bunReads;
  if (module === "crypto") return new Set(["randomBytes", "randomUUID", "createHash"]);
  if (module === "os") return new Set(["homedir", "tmpdir", "platform", "arch", "type", "release"]);
  if (module === "tty") return new Set(["isatty"]);
  // process imports are disallowed: the global view below is deliberately narrow.
  return undefined;
};
export function sensitiveModule(module: string): boolean {
  // Unknown builtins and third-party capability providers also fail closed.
  // Repository modules remain subject to the update-module/reference inventory.
  return !module.startsWith("./") && !module.startsWith("../")
    && !utilityModules.has(module.replace(/^node:/, ""));
}
const text = (node: ts.Node) => node.getText().replace(/\s+/g, " ");
const member = (node: ts.Node): { base: ts.Expression; name?: string } | undefined => {
  if (ts.isPropertyAccessExpression(node)) return { base: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node)) return { base: node.expression,
    name: node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined };
};
const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
  || ts.isAsExpression(node) ? unwrap(node.expression) : node;

export function capabilityPolicy(source: ts.SourceFile, file = "") {
  const context = (node: ts.Node) => {
    for (let p = node.parent; p; p = p.parent) if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    return "<module>";
  };
  const deferredKey = (node: ts.Node) => {
    let parent = node;
    while (parent.parent && !ts.isVariableDeclaration(parent) && !ts.isBinaryExpression(parent)) parent = parent.parent;
    return file + ":" + context(node) + ":" + text(parent);
  };
  const exactSites = new Set([...updatePrimitiveAllowlist, ...updateProcessAllowlist].map(([key]) => key));
  const exactSite = (node: ts.Node) => exactSites.has(file + ":" + context(node) + ":" + text(node));
  const boundaryRootCounts = new Map<string, number>();
  const trustedRootSite = (node: ts.Node) => {
    const key = file + ":" + context(node) + ":" + text(node);
    return updateBoundaryRootSites.has(key) && boundaryRootCounts.get(key) === 1;
  };
  const deferredCounts = new Map<string, number>();
  for (const key of updateDeferredImports) deferredCounts.set(key, (deferredCounts.get(key) ?? 0) + 1);
  const actualDeferred = new Map<string, number>();
  const functions: ts.FunctionDeclaration[] = [];
  const collect = (node: ts.Node) => {
    const rootKey = file + ":" + context(node) + ":" + text(node);
    if (updateBoundaryRootSites.has(rootKey)) boundaryRootCounts.set(rootKey, (boundaryRootCounts.get(rootKey) ?? 0) + 1);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "bunBinDir") functions.push(node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const key = deferredKey(node); actualDeferred.set(key, (actualDeferred.get(key) ?? 0) + 1);
    }
    node.forEachChild(collect);
  }; collect(source);
  const resolver = file === "bin/ocx.mjs" && functions.length === 1 ? functions[0] : undefined;
  const resolverBody = resolver?.body?.statements;
  const confinedResolver = resolver?.parameters.length === 1 && text(resolver.parameters[0]) === "launcherPath"
    && resolverBody?.length === 2
    && text(resolverBody[0]) === 'const resolver = createRequire(launcherPath || import.meta.url);'
    && text(resolverBody[1]) === 'return dirname(resolver.resolve("bun/package.json"));';
  const inResolver = (node: ts.Node) => {
    for (let p: ts.Node | undefined = node; p; p = p.parent) if (p === resolver) return !!confinedResolver;
    return false;
  };
  const forbiddenRoots = new Set(["require", "module", "exports", "createRequire", "globalThis", "global", "window", "self",
    "eval", "Function", "Reflect", "Proxy", "WebAssembly", "WebSocket", "Worker", "SharedWorker", "EventSource", "fetch"]);
  const isName = (node: ts.Identifier) => {
    const p = node.parent;
    return ts.isPropertyAccessExpression(p) && p.name === node || ts.isPropertyAssignment(p) && p.name === node && !ts.isComputedPropertyName(p.name)
      || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)
      || ts.isBindingElement(p) && p.propertyName === node;
  };
  const bindings = new Map<string, { module: string; name?: string }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue;
    const module = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (!sensitiveModule(module) && updateStaticImports[file]?.includes(text(statement))) continue;
    const clause = statement.importClause;
    if (clause.name) bindings.set(clause.name.text, { module });
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, { module });
    if (named && ts.isNamedImports(named)) for (const binding of named.elements)
      if (!binding.isTypeOnly) bindings.set(binding.name.text, { module, name: (binding.propertyName ?? binding.name).text });
  }
  const safeImport = (module: string, name?: string) => name !== undefined && !!readsFor(module)?.has(name);
  // Propagate forbidden acquisition identity through declarations, assignments,
  // destructuring and call results. The root itself is rejected even if unused;
  // this propagation also makes the inventory report downstream loader aliases.
  const tainted = new Set<string>();
  const rootViolation = (node: ts.Node): boolean => {
    if (ts.isMetaProperty(node)) {
      const p = node.parent;
      return !(ts.isPropertyAccessExpression(p) && p.expression === node
        && (p.name.text === "url" || file === "src/update/service-home-probe-entry.ts" && p.name.text === "main"));
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const key = deferredKey(node);
      return !deferredCounts.has(key) || actualDeferred.get(key)! > deferredCounts.get(key)!;
    }
    if (!ts.isIdentifier(node) || isName(node)) return false;
    if (node.text === "createRequire" || node.text === "resolver") return !inResolver(node);
    if (forbiddenRoots.has(node.text) || tainted.has(node.text)) return true;
    if (["process", "Bun", "fs"].includes(node.text)) {
      const p = node.parent;
      if (ts.isTypeOfExpression(p)) return false;
      if (!ts.isPropertyAccessExpression(p) || p.expression !== node) return true;
      const reads = node.text === "process" ? processReads : node.text === "Bun" ? bunReads : fsReads;
      if (node.text === "process" && ["stdout", "stderr", "stdin"].includes(p.name.text)) {
        const outer = member(p.parent);
        if (outer?.base === p && ["isTTY", "fd", "columns", "rows"].includes(outer.name ?? "")) return false;
      }
      return !reads.has(p.name.text);
    }
    return false;
  };
  const hasRoot = (node: ts.Node): boolean => !exactSite(node) && !trustedRootSite(node)
    && (rootViolation(node) || node.forEachChild(hasRoot) === true);
  const bindNames = (node: ts.Node) => {
    if (ts.isIdentifier(node)) { const size = tainted.size; tainted.add(node.text); return size !== tainted.size; }
    let changed = false;
    node.forEachChild(child => { if (bindNames(child)) changed = true; }); return changed;
  };
  for (let changed = true; changed;) {
    changed = false;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && hasRoot(node.initializer)) changed = bindNames(node.name) || changed;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && hasRoot(node.right)) changed = bindNames(node.left) || changed;
      node.forEachChild(visit);
    }; visit(source);
  }
  const aliases: ts.VariableDeclaration[] = [];
  const findAliases = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) aliases.push(node); node.forEachChild(findAliases); };
  findAliases(source);
  for (let changed = true; changed;) {
    changed = false;
    for (const declaration of aliases) {
      const name = (declaration.name as ts.Identifier).text;
      if (bindings.has(name)) continue;
      let origin: { module: string; name?: string } | undefined;
      const inspect = (node: ts.Node) => {
        if (ts.isCallExpression(node)) return;
        if (ts.isIdentifier(node)) { const value = bindings.get(node.text); if (value && !safeImport(value.module, value.name)) origin = value; }
        node.forEachChild(inspect);
      };
      inspect(declaration.initializer!);
      if (origin) { bindings.set(name, origin); changed = true; }
    }
  }
  const reason = (node: ts.Node): string | undefined => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly || ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      const named = clause?.namedBindings;
      const readonlyImport = readsFor(specifier) && !clause?.name && named && ts.isNamedImports(named)
        && named.elements.every(b => b.isTypeOnly || safeImport(specifier, (b.propertyName ?? b.name).text));
      if (!readonlyImport && !updateStaticImports[file]?.includes(text(node))) return "unreviewed static dependency or binding";
    }
    if (rootViolation(node)) return "forbidden capability root/acquisition/escape";
    if (ts.isImportDeclaration(node) && !node.importClause && sensitiveModule((node.moduleSpecifier as ts.StringLiteral).text))
      return "unapproved capability side-effect import";
    if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
      const module = (node.moduleSpecifier as ts.StringLiteral).text, clause = node.importClause;
      if (sensitiveModule(module) && (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)
        || clause.namedBindings.elements.some(b => !b.isTypeOnly && !safeImport(module, (b.propertyName ?? b.name).text))))
        return "unapproved capability import";
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly
      && sensitiveModule((node.moduleSpecifier as ts.StringLiteral).text)) return "capability re-export";
    if (ts.isImportEqualsDeclaration(node)) return "capability require binding";
    if (ts.isCallExpression(node) && ["require", "import"].includes(text(node.expression))) {
      const target = node.arguments[0];
      if (!target || !ts.isStringLiteral(target) || sensitiveModule(target.text)) return "unapproved capability module load";
    }
    const access = member(node);
    if (access) {
      const base = unwrap(access.base), root = text(base);
      if ((root === "globalThis" || root === "global" || root === "window" || root === "self")
        && (!access.name || !["setTimeout", "clearTimeout", "setInterval", "clearInterval"].includes(access.name)))
        return "unapproved global capability";
      const allowed = root === "Bun" ? bunReads : root === "process" ? processReads
        : root === "fs" ? fsReads : undefined;
      if (allowed && (!access.name || !allowed.has(access.name))) {
        // Standard stream metadata is inert; writes still need an exact exemption.
        if (root === "process" && ["stdout", "stderr", "stdin"].includes(access.name ?? "")) {
          const outer = member(node.parent);
          if (outer && outer.base === node && ["isTTY", "fd", "columns", "rows"].includes(outer.name ?? "")) return;
        }
        return "unapproved runtime capability";
      }
    }
    if (ts.isIdentifier(node)) {
      if (inResolver(node) && ["createRequire", "resolver"].includes(node.text)) return;
      const parent = node.parent;
      // Names are not references, but shorthand properties and destructuring RHSs are.
      if (ts.isPropertyAccessExpression(parent) && parent.name === node
        || ts.isPropertyAssignment(parent) && parent.name === node
        || ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return;
      const imported = bindings.get(node.text);
      if (imported && !safeImport(imported.module, imported.name)) return "raw imported capability reference";
      if (["Bun", "process", "fs", "globalThis", "global", "window", "self"].includes(node.text) && !(member(parent)?.base === node)
        && !ts.isTypeOfExpression(parent)) return "runtime capability object escape";
      if (["WebSocket", "Worker", "SharedWorker", "EventSource", "fetch", "eval", "Function"].includes(node.text))
        return "unapproved runtime constructor/evaluator";
    }
  };
  return { reason, rootViolation, trustedRootSite };
}
