import { win32 } from "node:path";
import { realpathSync } from "node:fs";

/** Synchronous Node hooks cover both CommonJS and ESM, including the entrypoint.
 * Missing hook support fails before npm executes. No fallback to ancestor/global
 * module trees is allowed, even if an absent lookup directory appears later.
 * The hook is an argv-bound data module, never a writable preload on disk.
 */
export function windowsNpmExecutionArgs(npmCli: string, args: readonly string[]): string[] {
  const root = realpathSync.native(win32.dirname(win32.dirname(npmCli)));
  const source = [
    'import {registerHooks} from "node:module";',
    'import {fileURLToPath} from "node:url";',
    'import {win32} from "node:path";',
    `const root=${JSON.stringify(root)};`,
    'registerHooks({resolve(specifier,context,nextResolve){',
    'const resolved=nextResolve(specifier,context);',
    'if(resolved.url.startsWith("node:"))return resolved;',
    'if(!resolved.url.startsWith("file:"))throw new Error("npm_module_outside_execution_tree");',
    'const relative=win32.relative(root,fileURLToPath(resolved.url));',
    'if(win32.isAbsolute(relative)||relative.split(win32.sep)[0]==="..")throw new Error("npm_module_outside_execution_tree");',
    'return resolved;}});',
  ].join("\n");
  return ["--no-global-search-paths", "--import", `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`, npmCli, ...args];
}
