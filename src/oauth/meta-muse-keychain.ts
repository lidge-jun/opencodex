import { MuseLoginError } from "./meta-muse-errors";

// Approval includes typing a password. Five seconds kills security while the user types.
export const MUSE_KEYCHAIN_TIMEOUT_MS = 120_000;
export interface MuseKeychainProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}
interface KeychainDeps {
  spawn?: (argv: string[]) => MuseKeychainProcess;
  timeoutMs?: number;
}

export async function readMuseKeychain(signal?: AbortSignal, deps: KeychainDeps = {}): Promise<string> {
  if (signal?.aborted) throw new MuseLoginError("cancelled");
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? MUSE_KEYCHAIN_TIMEOUT_MS);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let child: MuseKeychainProcess | undefined;
  let exited = false;
  let onAbort: (() => void) | undefined;
  try {
    child = (deps.spawn ?? (argv => Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })))(
      ["/usr/bin/security", "find-generic-password", "-s", "ai.meta.dev.credentials", "-a", "meta", "-w"],
    );
    const finished = Promise.all([new Response(child.stdout).text(), child.exited.then(code => { exited = true; return code; })]);
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new MuseLoginError(signal?.aborted ? "cancelled" : "keychain-timeout"));
      if (deadline.aborted) onAbort();
      else deadline.addEventListener("abort", onAbort, { once: true });
    });
    const [out, code] = await Promise.race([finished, aborted]);
    if (signal?.aborted) throw new MuseLoginError("cancelled");
    if (code !== 0) {
      // security returns OSStatus truncated to an 8-bit process exit code (SecBase.h).
      // Unknown failures stay unknown; no stderr or credential output is retained.
      if (code === 44) throw new MuseLoginError("keychain-missing"); // errSecItemNotFound -25300
      if (code === 36) throw new MuseLoginError("keychain-locked"); // errSecInteractionNotAllowed -25308
      if (code === 51 || code === 128) throw new MuseLoginError("keychain-denied"); // -25293 / -128
      throw new MuseLoginError("keychain-unreadable");
    }
    if (!out.trim()) throw new MuseLoginError("keychain-unreadable");
    return out.trim();
  } catch (error) {
    if (signal?.aborted) throw new MuseLoginError("cancelled");
    if (error instanceof MuseLoginError) throw error;
    throw new MuseLoginError("keychain-unreadable");
  } finally {
    if (onAbort) deadline.removeEventListener("abort", onAbort);
    if (child && !exited) { try { child.kill(); } catch { /* already exited */ } }
  }
}
