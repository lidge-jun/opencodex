import { spyOn } from "bun:test";
import * as ffi from "bun:ffi";
import { resolve, sep } from "node:path";
import * as acl from "../../src/lib/windows-owner-acl";
import { windowsCanonicalPathMatches } from "../../src/codex/windows-installation-files";

// Same temp-ancestry mapping as windows-temp-ancestry: only ancestors ABOVE
// the hardened root are redirected. Root and all descendant checks stay real.
export function observeWindowsPlanJunction(root: string, junction: string) {
  const actualAsync = acl.verifyWindowsEntriesAclAsync;
  const actualSync = acl.verifyWindowsEntriesAcl;
  const actualDlopen = ffi.dlopen;
  const events: string[] = [];
  let active = false;
  const fixturePath = (path: string) => resolve(path.startsWith("\\\\?\\") ? path.slice(4) : path);
  const mapped = (entries: readonly acl.WindowsAclEntry[]) => {
    const anchor = root.toLowerCase();
    if (!entries.some(entry => {
      const path = fixturePath(entry.path).toLowerCase();
      return path === anchor || path.startsWith(anchor + sep);
    })) return entries;
    return entries.map(entry => entry.policy === "trusted-ancestry"
      && (root + sep).toLowerCase().startsWith((fixturePath(entry.path) + sep).toLowerCase())
      ? { ...entry, path: root } : entry);
  };
  spyOn(acl, "verifyWindowsEntriesAclAsync").mockImplementation(async (entries, timeout) => {
    const result = await actualAsync(mapped(entries), timeout);
    if (active && entries.some(entry => entry.policy === "write-private"
      && fixturePath(entry.path).toLowerCase() === root.toLowerCase())) {
      events.push(result ? "ancestry-ok" : "ancestry-failed");
    }
    return result;
  });
  spyOn(acl, "verifyWindowsEntriesAcl").mockImplementation((entries, timeout) => actualSync(mapped(entries), timeout));
  spyOn(ffi, "dlopen").mockImplementation(((...args: unknown[]) => {
    const library = Reflect.apply(actualDlopen, ffi, args) as { symbols: Record<string, (...args: unknown[]) => unknown> };
    const symbols = library.symbols;
    const inspect = symbols.GetFileInformationByHandleEx;
    const finalPath = symbols.GetFinalPathNameByHandleW;
    if (inspect && finalPath) {
      symbols.GetFileInformationByHandleEx = (...inspectArgs: unknown[]) => {
        const result = Reflect.apply(inspect, symbols, inspectArgs);
        if (active && result && inspectArgs[1] === 0 && inspectArgs[3] === 40) {
          const bytes = Buffer.from(ffi.toArrayBuffer(inspectArgs[2] as never, 0, 40));
          if ((bytes.readUInt32LE(32) & 0x400) !== 0) {
            const name = Buffer.alloc(32768 * 2);
            const count = Number(finalPath(inspectArgs[0], ffi.ptr(name), 32768, 0));
            if (count > 0 && count < 32768 && windowsCanonicalPathMatches(junction, name.toString("utf16le", 0, count * 2))) {
              events.push("junction-reparse");
            }
          }
        }
        return result;
      };
    }
    return library;
  }) as never);
  return {
    begin() { events.length = 0; active = true; },
    end() { active = false; return [...events]; },
  };
}
