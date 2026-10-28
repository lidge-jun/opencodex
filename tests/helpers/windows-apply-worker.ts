/** Owned offline fixture driver, never a production dispatch or installer input. */
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import { createCodexCliWorkerLifetime } from "../../src/codex/cli-update-worker";
import { allocateCodexCliUpdateGateOwner, createWorkerCommitWindow, codexCliUpdateIsCancelled } from "../../src/codex/cli-update-selection-gate";
import { startWindowsCliChild } from "../../src/codex/windows-cli-child";
import { setWindowsOwnerAclAsyncRunnerForTests } from "../../src/lib/windows-owner-acl";
import type { openWindowsCliApplyAuthority } from "../../src/codex/cli-update-job-store-windows";
import type { WindowsApplyAcquisition, WindowsApplyAuthorityPins } from "../../src/codex/cli-update-job-store-windows";
import { ptr } from "bun:ffi";
import { mkdirSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";

declare const self: Worker;
if (Bun.isMainThread === false) {
  let ran = false;
  const lifetime = createCodexCliWorkerLifetime(() => { self.onmessage = null; });
  self.onmessage = async event => {
    if (ran) return;
    ran = true;
    const { requestId, planId, inspectionDeps, target, gate, fence, aclReleaseFailure, replaceLock } = event.data;
    let anchor: { acquisition?: WindowsApplyAcquisition; owner?: { authority: Awaited<ReturnType<typeof openWindowsCliApplyAuthority>> } } | undefined;
    let replacementCreated = false;
    const nativeSettlements: { terminal: boolean; cleanupComplete: boolean }[] = [];
    const abort = new AbortController();
    const view = new Int32Array(gate), word = new Int32Array(fence);
    const owner = allocateCodexCliUpdateGateOwner(gate);
    try {
      const result = await applyCodexCliUpdate(planId, {
        platform: "win32", inspectionDeps, signal: abort.signal,
        isCancelled: codexCliUpdateIsCancelled(fence),
        commitWindow: createWorkerCommitWindow({ gate, fence, owner }),
        retainExecution: owner => { anchor = owner; return lifetime.retain(owner); },
        resolveTarget: () => ({ kind: "resolved", version: target.set.main.version,
          integrity: target.set.main.integrity, artifacts: target.set }),
        // The installer and metadata are offline owned fixtures; no host session controls.
        scanProcesses: () => ({ kind: "observed", processes: [] }),
        fetchArtifact: async (artifact, signal) => {
          if (!(signal instanceof AbortSignal)) throw new Error("not a real AbortSignal");
          return Buffer.from(artifact.installName === "@openai/codex" ? target.main : target.backing);
        },
        startWindowsChild: invocation => {
          const installing = invocation.policy === "installer";
          if (installing && (aclReleaseFailure || replaceLock)) {
            const authority = anchor!.owner!.authority, release = authority.release.bind(authority);
            authority.release = async () => {
              const ctx = anchor!.acquisition!.resources as { kernel: Parameters<WindowsApplyAuthorityPins["release"]>[1] };
              const close = ctx.kernel.symbols.CloseHandle;
              if (replaceLock) ctx.kernel.symbols.CloseHandle = handle => {
                const buffer = Buffer.alloc(32768 * 2);
                const length = ctx.kernel.symbols.GetFinalPathNameByHandleW(handle, ptr(buffer), 32768, 0);
                const isLock = buffer.toString("utf16le", 0, length * 2) === win32.toNamespacedPath(authority.lock);
                const result = close(handle);
                if (isLock && result) {
                  mkdirSync(authority.lock);
                  writeFileSync(win32.join(authority.lock, "owner.json"), requestId);
                  replacementCreated = true;
                }
                return result;
              };
              if (aclReleaseFailure) setWindowsOwnerAclAsyncRunnerForTests(async () => ({ success: false, timedOut: false, stdout: "" }));
              try { return await release(); }
              finally { ctx.kernel.symbols.CloseHandle = close; setWindowsOwnerAclAsyncRunnerForTests(null); }
            };
          }
          if (installing && (Atomics.load(view, 0) !== owner || Atomics.load(word, 0) !== 2)) throw new Error("native start outside commit");
          const child = startWindowsCliChild(invocation), wait = child.wait.bind(child);
          child.wait = async () => {
            if (Atomics.load(view, 0) !== owner) throw new Error("installation exclusion lost during native wait");
            const result = await wait();
            nativeSettlements.push({ terminal: result.terminal, cleanupComplete: result.cleanupComplete });
            return result;
          };
          if (installing) self.postMessage({ type: "native-start", requestId, committed: true });
          return child;
        },
      });
      self.postMessage({ type: "result", requestId, result, cleanupConfirmed: (!replaceLock || replacementCreated) && nativeSettlements.length > 0
        && nativeSettlements.every(item => item.terminal && item.cleanupComplete) });
    } catch {
      self.postMessage({ type: "fixture-error", requestId });
    } finally { lifetime.finish(); }
  };
}
