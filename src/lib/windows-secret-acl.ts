/**
 * Windows per-user NTFS ACL hardening for secret files and directories.
 *
 * On Windows, `chmod` only controls POSIX-style bits in the ACE list and does NOT remove
 * inherited permissions from other users. Real per-user isolation requires icacls to:
 *   1. Grant the current user full control (icacls path /grant:r "CURRENTUSER:(F)")
 *   2. Disable inheritance               (icacls path /inheritance:r)
 *   3. Strip broad explicit grants by SID (Everyone, Users, Authenticated Users)
 *
 * Owner grant MUST precede `/inheritance:r`. That flag is destructive: it drops inherited
 * ACEs immediately. If a later step times out after inheritance is removed but before an
 * explicit owner ACE exists, the temp is left with a protected empty DACL — owned by the
 * current user yet unreadable/ununlinkable until Full Control is restored (issue #596).
 *
 * On non-Windows platforms the helpers fall through to the caller's existing chmod-based
 * behaviour: they return ok:true without invoking any external process.
 *
 * Design:
 *   hardenSecretPath(path, { required: false }) — non-fatal read-path mode.
 *     Never throws. Returns { ok, diagnostics? }.
 *   hardenSecretPath(path, { required: true })  — write-path mode.
 *     Throws a sanitized error (no raw path) on every Windows ACL failure,
 *     including genuine icacls timeouts. Required secret publication therefore
 *     fails closed; only required:false read-path probes may soft-fail.
 *   hardenSecretPathAsync / hardenSecretDirAsync — same policy, async icacls
 *     runner so the event loop is not held for the child lifetime (#612).
 *   HardenOptions.timeoutMemoKey — optional destination-path key for the
 *     timeout memo (atomic writers mint unique temps; never a parent directory).
 *   hardenSecretDir  — same contract for directories.
 */

import { existsSync, statSync } from "node:fs";
import { env, platform } from "node:process";

const hardenedDirectories = new Map<string, HardenedIdentity>();
const hardenedPaths = new Map<string, HardenedIdentity>();
/** Paths whose harden TIMED OUT this process: do not re-stall every loadConfig on them. */
const timedOutPaths = new Set<string>();

/**
 * The memo value: `object:freshness` for a file a harden was actually attributed
 * to.
 *
 * There is deliberately no null member. An observation that cannot be read is
 * not stored at all — the entry is deleted — because a "recorded as unverifiable"
 * value was dead code the moment attribution became a before/after comparison,
 * and a branch nothing can reach is a branch no test can defend.
 */
type HardenedIdentity = string;

/**
 * What a stat can tell us about WHICH OBJECT is at a path.
 *
 * Two fields, deliberately separated, because conflating them shipped a bug:
 *
 * - `object` — `dev:ino`. Answers "is this the same file". Survives an ACL or
 *   permission change, which is exactly what we need across an icacls call.
 * - `freshness` — `ctimeNs`. Answers "has this file's metadata moved since". It
 *   distinguishes an unlink/recreate that ext4 gave the same inode back for, and
 *   it MOVES when permissions change.
 *
 * The first version used `dev:ino:ctimeNs` for both jobs. Since chmod bumps ctime
 * — probed, `{ctimeChangedByChmod: true}` — and icacls is a permission change, the
 * before/after comparison would have rejected its own successful harden and failed
 * closed on every first harden on Windows. Requiring the identity to be unchanged
 * across an operation whose entire purpose is to change it is not a strict check;
 * it is a broken one.
 */
interface PathObservation {
  readonly object: string;
  readonly freshness: string;
}

/**
 * Observe which object is at a path, and how fresh it is.
 *
 * `dev:ino` alone is not enough to detect a replacement, which a Linux CI run
 * proved: ext4 reuses the inode of an unlinked file immediately — 100 of 100
 * unlink/recreate cycles produced the SAME `ino`, while macOS reused none in 200
 * and happily reported the earlier fix working. That is why `freshness` exists;
 * `ctimeNs` differed in 100 of 100 of those same cycles.
 *
 * `bigint: true` is used because `ctimeNs` exists only in that variant.
 *
 * Test seam: `setStatForTests` replaces this reader so a test can vary `dev`,
 * `ino`, and `ctimeNs` independently. Mirroring the implementation's string
 * format in test setup proves nothing about which components production uses —
 * an audit removed `dev` and all forty tests still passed.
 *
 * UNVERIFIED: the plain `ino` is reported to be 0 on NTFS while the bigint form
 * carries the file index, and the zero-ino guard exists for that case. Neither
 * Darwin nor Linux CI can confirm it and no pinned-Bun Windows probe has run.
 * It is defensive code, not a demonstrated platform fact.
 */
type StatReader = (path: string) => { dev: bigint; ino: bigint; ctimeNs: bigint };

const defaultStatReader: StatReader = path => {
  const s = statSync(path, { bigint: true });
  return { dev: s.dev, ino: s.ino, ctimeNs: s.ctimeNs };
};

let statReader: StatReader = defaultStatReader;

/** Test seam: drive dev / ino / ctime independently. */
export function setStatForTests(reader: StatReader | null): void {
  statReader = reader ?? defaultStatReader;
}

function observe(targetPath: string): PathObservation | null {
  try {
    const s = statReader(targetPath);
    if (s.ino === 0n) return null;
    return { object: `${s.dev}:${s.ino}`, freshness: `${s.ctimeNs}` };
  } catch {
    return null;
  }
}

function memoValue(seen: PathObservation): HardenedIdentity {
  return `${seen.object}:${seen.freshness}`;
}

/**
 * True only when this exact FILE was hardened, not merely this pathname.
 *
 * The memo used to be a `Set<string>` of paths. A stable destination — such as
 * the coordinator database `hardenStableLockFile` hardens — can be unlinked and
 * recreated at the same name, and the replacement inherited the previous file's
 * hardening while never having been through icacls. Ephemeral temps escaped this
 * only because atomic writers call `forgetEphemeralSecretPath` once the temp is
 * gone; nothing does that for a stable path.
 */
function memoSatisfied(cache: Map<string, HardenedIdentity>, targetPath: string): boolean {
  const remembered = cache.get(targetPath);
  if (remembered === undefined) return false;
  const current = observe(targetPath);
  // Unreadable now is not "unchanged": re-harden rather than trust a value we
  // cannot confirm still describes what is there.
  //
  // A miss RETIRES the entry rather than leaving it. Keeping it left the cache in
  // a state nothing could justify: after a mismatch and a failed re-harden, the
  // stale value survived, so restoring the old identity would satisfy it again
  // without any ACL work. That needs exact-identity ABA to bite — outside the
  // proof bound this unit claims — but "the consequence is out of scope" is not a
  // reason to keep an entry we have just proven does not describe what is there.
  if (current === null || memoValue(current) !== remembered) {
    cache.delete(targetPath);
    return false;
  }
  return true;
}

/**
 * Record a harden ONLY if the file we hardened is still the file at that path.
 *
 * Reading identity after the ACL sequence returns answers "what is there now",
 * which is not the same question as "what did icacls operate on". A replacement
 * landing mid-sequence — probed by swapping the file during the final
 * `/remove:g` — made the memo remember the REPLACEMENT as hardened, so the next
 * acquisition skipped ACL work on a file that had never seen it:
 *
 *   {identityChangedDuringHarden: true, callsForOriginal: 3, totalCalls: 3,
 *    replacementWasHardened: false}
 *
 * So the OBJECT is captured before the sequence and compared after it. Only the
 * object — `dev:ino` — because icacls changes permissions, and `ctimeNs` moves
 * when permissions change (probed: `{ctimeChangedByChmod: true}`). Comparing the
 * full identity across the call would have rejected every successful harden and
 * failed closed on the first harden on Windows: the check would have been
 * demanding that an operation not do the thing it exists to do.
 *
 * The memo then stores the object plus the freshness read AFTER hardening, which
 * is the state a later lookup should match.
 *
 * A changed object, or an unreadable observation at either end, means we cannot
 * say what was hardened: the memo is cleared rather than written, and required
 * callers fail closed. An optional caller soft-fails, as it does for every other
 * unproven ACL.
 *
 * Returns true when the harden may be reported successful.
 */
function recordHarden(
  cache: Map<string, HardenedIdentity>,
  targetPath: string,
  before: PathObservation | null,
): boolean {
  const after = observe(targetPath);
  if (before === null || after === null || before.object !== after.object) {
    // Never leave a memo behind for a file we cannot vouch for, including one
    // written by an earlier successful harden of a now-replaced file.
    cache.delete(targetPath);
    return false;
  }
  cache.set(targetPath, memoValue(after));
  return true;
}

const SUBSTITUTED_DIAGNOSTIC =
  "ACL hardening could not be attributed — the file at this path changed during hardening";

export interface HardenResult {
  ok: boolean;
  diagnostics?: string;
}

export interface HardenOptions {
  required: boolean;
  /**
   * Optional timeout-memo key distinct from `targetPath` (issue #612).
   * Atomic writers mint a fresh `.tmp` path per write; keying the timeout cache by the
   * final destination path prevents re-stalling the event loop on every subsequent temp.
   * Must NOT be a parent directory — directory ACLs are not authoritative for new files.
   */
  timeoutMemoKey?: string;
}

/**
 * Total icacls budget per harden call — ALL steps share it, including the single
 * timeout retry and the diagnostic verification pass (no per-attempt fresh budget:
 * loadConfig hardens dir+config+auth sequentially, so per-attempt budgets stack
 * into multi-minute startup stalls). Override with OPENCODEX_ACL_TIMEOUT_MS
 * (integer ms, clamped to [1000, 60000]; invalid values fall back to 5000).
 */
const HARDEN_DEADLINE_DEFAULT_MS = 5_000;
const HARDEN_DEADLINE_MIN_MS = 1_000;
const HARDEN_DEADLINE_MAX_MS = 60_000;

/** Resolve the total harden budget once per call (env mutation cannot change it midway). */
function resolveHardenDeadlineMs(): number {
  const raw = env["OPENCODEX_ACL_TIMEOUT_MS"]?.trim();
  if (!raw) return HARDEN_DEADLINE_DEFAULT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return HARDEN_DEADLINE_DEFAULT_MS;
  return Math.min(HARDEN_DEADLINE_MAX_MS, Math.max(HARDEN_DEADLINE_MIN_MS, parsed));
}

export interface IcaclsResult {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
}

type IcaclsRunner = (args: string[], timeoutMs: number) => IcaclsResult;
type AsyncIcaclsRunner = (args: string[], timeoutMs: number) => Promise<IcaclsResult>;

function defaultIcaclsRunner(args: string[], timeoutMs: number): IcaclsResult {
  // Bun.spawnSync with windowsHide: Node execFileSync has hung under the GUI/proxy even
  // with windowsHide, and console-subsystem tools flash a visible window otherwise.
  const result = Bun.spawnSync(["icacls.exe", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    success: result.success,
    exitCode: result.exitCode,
    timedOut: result.exitedDueToTimeout ?? false,
    stdout: result.stdout ? result.stdout.toString() : "",
  };
}

/**
 * Async icacls runner (#612): yields the event loop while waiting for the child.
 * Timeout provenance is recorded by our timer (async Subprocess has no exitedDueToTimeout);
 * we still await process exit before classifying so settlement is confirmed.
 */
async function defaultAsyncIcaclsRunner(args: string[], timeoutMs: number): Promise<IcaclsResult> {
  const proc = Bun.spawn(["icacls.exe", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  });
  let timedOutByUs = false;
  const timer = setTimeout(() => {
    timedOutByUs = true;
    try { proc.kill(); } catch { /* already exited */ }
  }, Math.max(1, timeoutMs));
  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  const stdout = proc.stdout
    ? await new Response(proc.stdout).text().catch(() => "")
    : "";
  const timedOut = timedOutByUs;
  return {
    success: !timedOut && exitCode === 0,
    exitCode: timedOut ? null : exitCode,
    timedOut,
    stdout,
  };
}

let icaclsRunner: IcaclsRunner = defaultIcaclsRunner;
let asyncIcaclsRunner: AsyncIcaclsRunner = defaultAsyncIcaclsRunner;
let platformOverride: string | null = null;
let nowFn: () => number = Date.now;

/** Test seam: replace the icacls process runner. Pass null to restore the default. */
export function setIcaclsRunnerForTests(runner: IcaclsRunner | null): void {
  icaclsRunner = runner ?? defaultIcaclsRunner;
}

/** Test seam: replace the async icacls runner. Pass null to restore the default. */
export function setAsyncIcaclsRunnerForTests(runner: AsyncIcaclsRunner | null): void {
  asyncIcaclsRunner = runner ?? defaultAsyncIcaclsRunner;
}

/** Test seam: force the platform gate (e.g. "win32") so CI on POSIX reaches the runner. */
export function setPlatformForTests(value: string | null): void {
  platformOverride = value;
}

/** Test seam: injectable clock for deadline tests (no real sleeps). */
export function setNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? Date.now;
}

/** Test seam: clear memo/failure caches between cases. */
export function resetHardenedStateForTests(): void {
  hardenedDirectories.clear();
  hardenedPaths.clear();
  timedOutPaths.clear();
}

/** Forget a successful harden only after this exact ephemeral path is gone. */
export function forgetHardenedSecretPath(targetPath: string): void {
  hardenedPaths.delete(targetPath);
}

/**
 * Ephemeral-path lifecycle release: clears the success memo AND any timeout
 * memo keyed by THIS TEMP path in both namespaces. Call only after the temp is
 * proven absent (successful rename, successful unlink, ENOENT, or an explicit
 * non-existence check). Never pass a stable destination: destination-keyed
 * timeout memos are intentional anti-restall state and are not touched here.
 */
export function forgetEphemeralSecretPath(tempPath: string): void {
  hardenedPaths.delete(tempPath);
  timedOutPaths.delete(`required:${tempPath}`);
  timedOutPaths.delete(`optional:${tempPath}`);
}

/** Test seam: timeout memo sets return to baseline after ephemeral cleanup. */
export function timedOutSecretPathCountForTests(): number {
  return timedOutPaths.size;
}

/** Test seam for proving ephemeral success memos do not grow across replacements. */
export function hardenedSecretPathCountForTests(): number {
  return hardenedPaths.size;
}

/**
 * Directory counterpart. It had no seam, and that absence hid a real gap: a
 * directory-only pathname memo passed every file-based test in this suite.
 */
export function hardenedSecretDirCountForTests(): number {
  return hardenedDirectories.size;
}

function effectivePlatform(): string {
  return platformOverride ?? platform;
}

/** Test-aware platform predicate for callers that must avoid even a no-op ACL call. */
export function windowsSecretAclApplies(): boolean {
  return (platformOverride ?? process.platform) === "win32";
}

/** Error carrying an honest code: ETIMEDOUT only for real timeouts, EICACLS otherwise. */
function icaclsError(step: string, result: IcaclsResult): NodeJS.ErrnoException {
  const err = new Error(
    result.timedOut ? `icacls ${step} timed out` : `icacls ${step} exited ${result.exitCode ?? "null"}`,
  ) as NodeJS.ErrnoException;
  err.code = result.timedOut ? "ETIMEDOUT" : "EICACLS";
  return err;
}

/**
 * Return the current Windows username from the environment.
 * Falls back to USERDOMAIN\USERNAME if USERNAME alone is ambiguous.
 * The value is used directly in icacls arguments, so it must be present.
 */
function currentWindowsUser(): string | undefined {
  const username = env["USERNAME"];
  const domain = env["USERDOMAIN"];
  if (!username) return undefined;
  // USERDOMAIN is the machine/domain name; USERNAME is the account name.
  // icacls accepts "DOMAIN\User" or just "User" for local accounts.
  return domain ? `${domain}\\${username}` : username;
}

/**
 * Run icacls to harden a single file system entry.
 * Order is intentional (issue #596): grant the owner ACE first so a later
 * `/inheritance:r` or `/remove:g` timeout cannot strand a protected zero-ACE DACL.
 *
 * We do NOT use a shell string; all arguments are passed as an array so no
 * shell injection is possible even for paths with unusual characters.
 *
 * Throws the raw child_process error on failure (caller sanitizes).
 */
const BROAD_SIDS = ["*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"] as const;

function grantAce(user: string, directory: boolean): string {
  return directory ? `${user}:(OI)(CI)(F)` : `${user}:(F)`;
}

function runIcacls(targetPath: string, directory: boolean, deadline: number): void {
  const user = currentWindowsUser();
  if (!user) {
    throw new Error("Cannot determine current Windows user for ACL hardening");
  }

  // The deadline is owned by hardenEntry (total budget incl. retry + verification).
  const run = (step: string, args: string[]): IcaclsResult => {
    const remaining = deadline - nowFn();
    if (remaining <= 0) {
      throw icaclsError(step, { success: false, exitCode: null, timedOut: true, stdout: "" });
    }
    return icaclsRunner(args, remaining);
  };
  const runOrThrow = (step: string, args: string[]): void => {
    const result = run(step, args);
    if (!result.success) throw icaclsError(step, result);
  };

  // Step 1: grant current user full control BEFORE any destructive ACL change.
  // If this fails, inheritance is untouched and the writer keeps inherited access.
  runOrThrow("/grant:r", [targetPath, "/grant:r", grantAce(user, directory)]);

  // Step 2: disable inheritance and remove inherited ACEs. The explicit owner ACE
  // from step 1 survives this transition, so a later failure still leaves cleanup access.
  runOrThrow("/inheritance:r", [targetPath, "/inheritance:r"]);

  // Step 3: remove broad explicit grants using stable SIDs (not localized names).
  // Missing ACEs can yield a non-zero exit; verify with locale-independent /findsid
  // before accepting the failure as harmless — a swallowed real failure would leave
  // Everyone/Users/Authenticated Users grants while reporting hardened.
  // `/remove:g` cannot remove the explicit current-user ACE installed in step 1.
  const removal = run("/remove:g", [targetPath, "/remove:g", ...BROAD_SIDS]);
  if (!removal.success) {
    if (removal.timedOut) throw icaclsError("/remove:g", removal);
    for (const sid of BROAD_SIDS) {
      const found = run("/findsid", [targetPath, "/findsid", sid]);
      if (!found.success) throw icaclsError("/findsid", found);
      // icacls /findsid echoes the target path in its "SID Found" line only when the SID
      // still holds an ACE; the summary lines carry only counts. Matching the path echo —
      // not the (localized) prose — keeps the check locale-independent.
      if (found.stdout.includes(targetPath)) {
        throw icaclsError("/remove:g", removal);
      }
    }
  }
}

/** Async counterpart of runIcacls — same step order and timeout/error classification (#612). */
async function runIcaclsAsync(targetPath: string, directory: boolean, deadline: number): Promise<void> {
  const user = currentWindowsUser();
  if (!user) {
    throw new Error("Cannot determine current Windows user for ACL hardening");
  }

  const run = async (step: string, args: string[]): Promise<IcaclsResult> => {
    const remaining = deadline - nowFn();
    if (remaining <= 0) {
      throw icaclsError(step, { success: false, exitCode: null, timedOut: true, stdout: "" });
    }
    return asyncIcaclsRunner(args, remaining);
  };
  const runOrThrow = async (step: string, args: string[]): Promise<void> => {
    const result = await run(step, args);
    if (!result.success) throw icaclsError(step, result);
  };

  await runOrThrow("/grant:r", [targetPath, "/grant:r", grantAce(user, directory)]);
  await runOrThrow("/inheritance:r", [targetPath, "/inheritance:r"]);

  const removal = await run("/remove:g", [targetPath, "/remove:g", ...BROAD_SIDS]);
  if (!removal.success) {
    if (removal.timedOut) throw icaclsError("/remove:g", removal);
    for (const sid of BROAD_SIDS) {
      const found = await run("/findsid", [targetPath, "/findsid", sid]);
      if (!found.success) throw icaclsError("/findsid", found);
      if (found.stdout.includes(targetPath)) {
        throw icaclsError("/remove:g", removal);
      }
    }
  }
}

/**
 * Sanitize an error from a failed ACL operation into a safe diagnostic string.
 * The raw path must not appear in the returned string (it may contain
 * sensitive username components or PII from the home directory path).
 */
function sanitizeDiagnostics(error: unknown): string {
  // We do not expose the raw error message or any path-like fragments —
  // just an honest, code-specific cause (issue #160: a transient icacls stall
  // must not read like filesystem non-support).
  const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
  switch (code) {
    case "ETIMEDOUT":
      return "ACL hardening timed out (ETIMEDOUT) — transient icacls stall; the volume may still support per-user NTFS ACLs";
    case "EPERM":
    case "EACCES":
      return `ACL hardening failed (${code}) — permission denied running icacls`;
    case "EICACLS":
      return "ACL hardening failed (EICACLS) — icacls command error; filesystem may not support per-user NTFS ACLs";
    default:
      return `ACL hardening failed${code ? ` (${code})` : ""} — filesystem may not support per-user NTFS ACLs`;
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && String((error as NodeJS.ErrnoException).code) === "ETIMEDOUT";
}

/**
 * Diagnostic-only post-timeout probe (never promotes to ok:true — a clean /findsid
 * does not prove inheritance was disabled or the user grant ran; only a fully
 * completed harden sequence may enter the hardened cache). Bounded by the remaining
 * total budget; returns a short state note for the soft-fail diagnostic.
 */
function describeAclStateAfterTimeout(targetPath: string, deadline: number): string {
  try {
    for (const sid of BROAD_SIDS) {
      const remaining = deadline - nowFn();
      if (remaining <= 0) return "ACL state unverified (budget exhausted)";
      const found = icaclsRunner([targetPath, "/findsid", sid], remaining);
      if (!found.success) return "ACL state unverified (probe failed)";
      if (found.stdout.includes(targetPath)) return "broad ACL grants still present";
    }
    return "no broad ACL grants detected (hardening still incomplete)";
  } catch {
    return "ACL state unverified (probe failed)";
  }
}

async function describeAclStateAfterTimeoutAsync(targetPath: string, deadline: number): Promise<string> {
  try {
    for (const sid of BROAD_SIDS) {
      const remaining = deadline - nowFn();
      if (remaining <= 0) return "ACL state unverified (budget exhausted)";
      const found = await asyncIcaclsRunner([targetPath, "/findsid", sid], remaining);
      if (!found.success) return "ACL state unverified (probe failed)";
      if (found.stdout.includes(targetPath)) return "broad ACL grants still present";
    }
    return "no broad ACL grants detected (hardening still incomplete)";
  } catch {
    return "ACL state unverified (probe failed)";
  }
}

function timeoutMemoKey(targetPath: string, opts: HardenOptions): string {
  // Destination-path memo only (issue #612). Never a parent directory — directory ACLs
  // are not authoritative for newly created temps.
  //
  // Namespace by required-ness (#766): a soft `required:false` timeout during loadConfig
  // must not poison a later `required:true` management-token harden of the same path.
  const base = opts.timeoutMemoKey ?? targetPath;
  return `${opts.required ? "required" : "optional"}:${base}`;
}

/**
 * Shared harden flow for files and directories: one total budget (env-configurable)
 * covering the initial attempt, ONE timeout retry, and the diagnostic verification.
 * Required paths fail closed for every hardening failure, including genuine
 * timeouts. Optional read paths soft-fail with an honest diagnostic.
 */
function hardenEntry(
  targetPath: string,
  directory: boolean,
  opts: HardenOptions,
  cache: Map<string, HardenedIdentity>,
): HardenResult {
  // Observed absence retires the memo. Leaving it would let a later file at this
  // path satisfy the cache if the filesystem ever hands back a matching identity.
  if (!existsSync(targetPath)) { cache.delete(targetPath); return { ok: true }; }
  if (effectivePlatform() !== "win32") return { ok: true };
  if (memoSatisfied(cache, targetPath)) return { ok: true };
  const memoKey = timeoutMemoKey(targetPath, opts);
  if (timedOutPaths.has(memoKey)) {
    const diagnostics = "ACL hardening skipped — previous attempt timed out";
    if (opts.required) throw new Error(diagnostics);
    return { ok: false, diagnostics };
  }

  const deadline = nowFn() + resolveHardenDeadlineMs();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && deadline - nowFn() <= 0) break; // retry only while budget remains
    try {
      // Captured BEFORE the sequence: this is the file we are about to harden.
      const before = observe(targetPath);
      runIcacls(targetPath, directory, deadline);
      if (!recordHarden(cache, targetPath, before)) {
        if (opts.required) throw new Error(SUBSTITUTED_DIAGNOSTIC);
        return { ok: false, diagnostics: SUBSTITUTED_DIAGNOSTIC };
      }
      return { ok: true };
    } catch (err) {
      // A substitution is not a transient icacls stall; do not spend the retry on it.
      if (err instanceof Error && err.message === SUBSTITUTED_DIAGNOSTIC) throw err;
      lastErr = err;
      if (!isTimeoutError(err)) break; // real failures do not retry
    }
  }

  const diagnostics = sanitizeDiagnostics(lastErr);
  if (isTimeoutError(lastErr)) {
    timedOutPaths.add(memoKey);
    const state = describeAclStateAfterTimeout(targetPath, deadline);
    const annotated = `${diagnostics}; ${state}`;
    if (opts.required) throw new Error(annotated);
    console.warn(`[opencodex] ${annotated} — continuing without NTFS ACL harden`);
    return { ok: false, diagnostics: annotated };
  }
  if (opts.required) throw new Error(diagnostics);
  return { ok: false, diagnostics };
}

/** Async counterpart of hardenEntry — yields while waiting on icacls (#612). */
async function hardenEntryAsync(
  targetPath: string,
  directory: boolean,
  opts: HardenOptions,
  cache: Map<string, HardenedIdentity>,
): Promise<HardenResult> {
  if (!existsSync(targetPath)) { cache.delete(targetPath); return { ok: true }; }
  if (effectivePlatform() !== "win32") return { ok: true };
  if (memoSatisfied(cache, targetPath)) return { ok: true };
  const memoKey = timeoutMemoKey(targetPath, opts);
  if (timedOutPaths.has(memoKey)) {
    const diagnostics = "ACL hardening skipped — previous attempt timed out";
    if (opts.required) throw new Error(diagnostics);
    return { ok: false, diagnostics };
  }

  const deadline = nowFn() + resolveHardenDeadlineMs();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && deadline - nowFn() <= 0) break;
    try {
      const before = observe(targetPath);
      await runIcaclsAsync(targetPath, directory, deadline);
      if (!recordHarden(cache, targetPath, before)) {
        if (opts.required) throw new Error(SUBSTITUTED_DIAGNOSTIC);
        return { ok: false, diagnostics: SUBSTITUTED_DIAGNOSTIC };
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof Error && err.message === SUBSTITUTED_DIAGNOSTIC) throw err;
      lastErr = err;
      if (!isTimeoutError(err)) break;
    }
  }

  const diagnostics = sanitizeDiagnostics(lastErr);
  if (isTimeoutError(lastErr)) {
    timedOutPaths.add(memoKey);
    const state = await describeAclStateAfterTimeoutAsync(targetPath, deadline);
    const annotated = `${diagnostics}; ${state}`;
    if (opts.required) throw new Error(annotated);
    console.warn(`[opencodex] ${annotated} — continuing without NTFS ACL harden`);
    return { ok: false, diagnostics: annotated };
  }
  if (opts.required) throw new Error(diagnostics);
  return { ok: false, diagnostics };
}

/**
 * Harden a single file path with per-user NTFS ACLs on Windows.
 * On non-Windows platforms, returns ok:true immediately (caller owns chmod).
 *
 * @param targetPath  Absolute path to the file to harden.
 * @param opts        { required: boolean } — required:true throws on failure.
 */
export function hardenSecretPath(targetPath: string, opts: HardenOptions): HardenResult {
  return hardenEntry(targetPath, false, opts, hardenedPaths);
}

/**
 * Async harden for write paths that must not block the event loop (#612).
 * Same success/timeout/error policy as hardenSecretPath.
 */
export function hardenSecretPathAsync(targetPath: string, opts: HardenOptions): Promise<HardenResult> {
  return hardenEntryAsync(targetPath, false, opts, hardenedPaths);
}

/**
 * Harden a directory path with per-user NTFS ACLs on Windows.
 * On non-Windows platforms, returns ok:true immediately (caller owns chmod).
 *
 * @param targetPath  Absolute path to the directory to harden.
 * @param opts        { required: boolean } — required:true throws on failure.
 */
export function hardenSecretDir(targetPath: string, opts: HardenOptions): HardenResult {
  return hardenEntry(targetPath, true, opts, hardenedDirectories);
}

/**
 * Async directory harden (#612). Same policy as hardenSecretDir.
 */
export function hardenSecretDirAsync(targetPath: string, opts: HardenOptions): Promise<HardenResult> {
  return hardenEntryAsync(targetPath, true, opts, hardenedDirectories);
}
