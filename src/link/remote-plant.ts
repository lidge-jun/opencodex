import { CHILD_TARGET_TRIPLES, type ChildTargetTriple } from "./child-binary-source";
import { MANAGED_PURGE_CHILD_MISSING_MARKER, windowsInspectRuntimeArgv, windowsManagedPurgeDisconnectArgv, windowsPlantChildArgv, windowsPurgePlantedChildArgv, windowsRecoverReceiptArgv } from "./remote-windows";
import { buildExecArgv, REMOTE_SERVED_RUNTIME, remoteServedRuntimeAttempt } from "./ssh-argv";
import type { ExplicitRoute } from "./explicit-route";
import { sshFailureHint, sshRunnerErrorHint, type SshRunner } from "./ssh-runner";

export type RemoteRuntimeKind = "full" | "ephemeral" | "missing";
export type ChildAttachConflictCode = "child_port_busy" | "child_external_provider_conflict";

export interface ParsedRemoteRuntimeInspection {
  readonly runtimeKind: RemoteRuntimeKind;
  readonly targetTriple: ChildTargetTriple | null;
  readonly rawArch: string;
  readonly ocxVersionLine: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function parseTargetTriple(platform: "posix" | "windows", rawArch: string): ChildTargetTriple | null {
  const trimmed = rawArch.trim();
  if (platform === "windows") {
    return /^(?:AMD64|x86_64|x64)$/i.test(trimmed) ? "windows-x64" : null;
  }
  const sep = trimmed.indexOf(":");
  if (sep <= 0) return null;
  const kernel = trimmed.slice(0, sep).trim().toLowerCase();
  const machine = trimmed.slice(sep + 1).trim().toLowerCase();
  if (kernel === "darwin") {
    if (machine === "arm64" || machine === "aarch64") return "darwin-arm64";
    if (machine === "x86_64" || machine === "amd64") return "darwin-x64";
    return null;
  }
  if (kernel === "linux") {
    if (machine === "x86_64" || machine === "amd64") return "linux-x64";
    if (machine === "aarch64" || machine === "arm64") return "linux-arm64";
    return null;
  }
  return null;
}

export const POSIX_INSPECT_SCRIPT = [
  "export PATH=\"$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin\"",
  "case \"$(uname -s 2>/dev/null)\" in Windows*|MSYS*|MINGW*|CYGWIN*) exit 125;; esac",
  "printf 'ocx-inspect:uname:%s:%s\\n' \"$(uname -s 2>/dev/null)\" \"$(uname -m 2>/dev/null)\"",
  "ocx_entry=",
  "try_inspect() {",
  "  kind=$1; candidate=$2",
  "  if [ -x \"$candidate\" ]; then",
  "    ver=$(\"$candidate\" ${ocx_entry:+\"$ocx_entry\"} --version 2>/dev/null) || return 0",
  "    first=$(printf '%s\\n' \"$ver\" | awk 'NR==1{print; exit}')",
  "    if [ -n \"$first\" ]; then",
  "      printf 'ocx-inspect:kind:%s\\n' \"$kind\"",
  "      printf 'ocx-inspect:version:%s\\n' \"$first\"",
  "      exit 0",
  "    fi",
  "  fi",
  "}",
  "inspect_ocx_child() {",
  "  for candidate in \"$HOME/.local/bin/ocx-child\" \"$HOME/.cache/opencodex/bin/ocx-child\"; do",
  "    try_inspect ephemeral \"$candidate\"",
  "  done",
  "  remaining=$PATH",
  "  while :; do",
  "    directory=${remaining%%:*}",
  "    try_inspect ephemeral \"${directory:-.}/ocx-child\"",
  "    case \"$remaining\" in *:*) remaining=${remaining#*:};; *) break;; esac",
  "  done",
  "}",
  "if [ -f \"${OPENCODEX_HOME:-$HOME/.opencodex}/child/state.json\" ]; then",
  "  inspect_ocx_child",
  "fi",
  // #8359: report the install that last started serving this home before any Desktop or PATH copy.
  REMOTE_SERVED_RUNTIME.trimEnd(),
  remoteServedRuntimeAttempt("try_inspect full \"$served_bin\""),
  "for candidate in \"$HOME/.opencodex-desktop/bin/ocx\" \"/Applications/OpenCodex.app/Contents/MacOS/ocx\" \"/usr/bin/ocx\"; do",
  "  try_inspect full \"$candidate\"",
  "done",
  "remaining=$PATH",
  "while :; do",
  "  directory=${remaining%%:*}",
  "  try_inspect full \"${directory:-.}/ocx\"",
  "  case \"$remaining\" in *:*) remaining=${remaining#*:};; *) break;; esac",
  "done",
  "inspect_ocx_child",
  "printf 'ocx-inspect:kind:missing\\n'",
  "exit 0",
].join("\n");

export function remoteInspectRuntimeArgv(platform: "posix" | "windows" = "posix"): string[] {
  return platform === "windows" ? windowsInspectRuntimeArgv() : ["sh", "-c", POSIX_INSPECT_SCRIPT, "ocx-inspect"];
}

export function parseRemoteRuntimeInspection(platform: "posix" | "windows", stdout: string): ParsedRemoteRuntimeInspection | null {
  let rawArch: string | null = null;
  let runtimeKind: RemoteRuntimeKind | null = null;
  let ocxVersionLine: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (platform === "posix" && line.startsWith("ocx-inspect:uname:")) {
      rawArch = line.slice("ocx-inspect:uname:".length);
    } else if (platform === "windows" && line.startsWith("ocx-inspect:arch:")) {
      rawArch = line.slice("ocx-inspect:arch:".length);
    } else if (line.startsWith("ocx-inspect:kind:")) {
      const kind = line.slice("ocx-inspect:kind:".length);
      if (kind === "full" || kind === "ephemeral" || kind === "missing") runtimeKind = kind;
    } else if (line.startsWith("ocx-inspect:version:")) {
      ocxVersionLine = line.slice("ocx-inspect:version:".length).trim();
    }
  }
  if (rawArch === null || runtimeKind === null) return null;
  if (runtimeKind !== "missing" && !ocxVersionLine) return null;
  const targetTriple = parseTargetTriple(platform, rawArch);
  return { runtimeKind, targetTriple: targetTriple && CHILD_TARGET_TRIPLES.includes(targetTriple) ? targetTriple : null, rawArch, ocxVersionLine };
}

export async function inspectRemoteChildRuntime(
  runner: Pick<SshRunner, "run">,
  alias: string,
  route: ExplicitRoute | null,
  knownHostsFile: string,
  platform: "posix" | "windows",
  timeoutMs = 30_000,
): Promise<ParsedRemoteRuntimeInspection | null> {
  const res = await runner.run(buildExecArgv({ alias, argv: remoteInspectRuntimeArgv(platform), knownHostsFile, route }), { timeoutMs });
  if (res.code !== 0) return null;
  return parseRemoteRuntimeInspection(platform, res.stdout);
}

/** Printed on stderr by the POSIX plant script when no tool can verify the binary's SHA-256. */
export const PLANT_HASH_TOOL_UNAVAILABLE_MARKER = "ocx-plant-error:hash_tool_unavailable";

export const POSIX_PLANT_SCRIPT = [
  "case \"$(uname -s 2>/dev/null)\" in Windows*|MSYS*|MINGW*|CYGWIN*) exit 125;; esac",
  "umask 077",
  "expected_bytes=$1",
  "expected_sha=$2",
  "for p in \"$HOME/.cache\" \"$HOME/.cache/opencodex\" \"$HOME/.cache/opencodex/bin\" \"$HOME/.cache/opencodex/bin/ocx-child\"; do",
  "  if [ -L \"$p\" ]; then printf 'Refusing symlink in managed plant path: %s\\n' \"$p\" >&2; exit 1; fi",
  "done",
  "mkdir -p \"$HOME/.cache/opencodex/bin\" || exit 1",
  "chmod 0700 \"$HOME/.cache/opencodex\" \"$HOME/.cache/opencodex/bin\" 2>/dev/null || true",
  "dest=\"$HOME/.cache/opencodex/bin/ocx-child\"",
  "tmp=\"$HOME/.cache/opencodex/bin/.ocx-child.tmp.$$\"",
  "trap 'rm -f \"$tmp\"' EXIT HUP INT TERM",
  "cat > \"$tmp\" || exit 1",
  "actual_bytes=$(wc -c < \"$tmp\" | awk '{print $1}') || exit 1",
  "if [ \"$actual_bytes\" != \"$expected_bytes\" ]; then",
  "  printf 'Planted binary size mismatch: expected %s got %s\\n' \"$expected_bytes\" \"$actual_bytes\" >&2",
  "  exit 1",
  "fi",
  // The digest must be checked before the binary is ever executed; with no tool to check it the
  // plant fails closed and the temporary file is removed by the EXIT trap.
  "if command -v sha256sum >/dev/null 2>&1; then",
  "  actual_sha=$(sha256sum \"$tmp\" | awk '{print tolower($1)}')",
  "elif command -v shasum >/dev/null 2>&1; then",
  "  actual_sha=$(shasum -a 256 \"$tmp\" | awk '{print tolower($1)}')",
  "elif command -v openssl >/dev/null 2>&1; then",
  "  actual_sha=$(openssl dgst -sha256 \"$tmp\" | awk '{print tolower($NF)}')",
  "else",
  `  printf '${PLANT_HASH_TOOL_UNAVAILABLE_MARKER}\\nNo sha256sum, shasum, or openssl on this host to verify the ocx-child binary.\\n' >&2`,
  "  exit 3",
  "fi",
  "if [ \"$actual_sha\" != \"$expected_sha\" ]; then printf 'Planted binary SHA-256 mismatch\\n' >&2; exit 1; fi",
  "chmod 0700 \"$tmp\" || exit 1",
  "mv -f \"$tmp\" \"$dest\" || exit 1",
  "trap - EXIT HUP INT TERM",
  "if ! \"$dest\" --version >/dev/null 2>&1; then",
  "  rm -f \"$dest\"",
  "  printf 'Planted ocx-child failed --version verification\\n' >&2",
  "  exit 1",
  "fi",
  "exit 0",
].join("\n");

export function remotePlantChildArgv(
  platform: "posix" | "windows",
  expectedBytes: number,
  expectedSha256: string,
): string[] {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > 32 * 1024 * 1024) {
    throw new Error("invalid expectedBytes for ocx-child plant");
  }
  if (!SHA256_HEX.test(expectedSha56Safe(expectedSha256))) throw new Error("invalid expectedSha256 for ocx-child plant");
  return platform === "windows"
    ? windowsPlantChildArgv(expectedBytes, expectedSha256)
    : ["sh", "-c", POSIX_PLANT_SCRIPT, "ocx-plant", String(expectedBytes), expectedSha256];
}

function expectedSha56Safe(v: string): string { return v; }

export const POSIX_PURGE_PLANTED_SCRIPT = [
  "case \"$(uname -s 2>/dev/null)\" in Windows*|MSYS*|MINGW*|CYGWIN*) exit 125;; esac",
  "for p in \"$HOME/.cache\" \"$HOME/.cache/opencodex\" \"$HOME/.cache/opencodex/bin\" \"$HOME/.cache/opencodex/bin/ocx-child\"; do",
  "  if [ -L \"$p\" ]; then exit 1; fi",
  "done",
  "dest=\"$HOME/.cache/opencodex/bin/ocx-child\"",
  "child_dir=\"${OPENCODEX_HOME:-$HOME/.opencodex}/child\"",
  "codex_home=\"${CODEX_HOME:-$HOME/.codex}\"",
  // Any record ocx-child keeps until an attach, sync, or detach finishes means the binary is still
  // the only way to recover, so it stays and the rollback reports a residual.
  "recovery_pending() {",
  "  for f in \"$child_dir/state.json\" \"$child_dir/codex-journal.json\" \"$child_dir/attach-rollback.json\" \"$codex_home/.ocx-child-owner.json\"; do",
  "    if [ -e \"$f\" ] || [ -L \"$f\" ]; then printf 'ocx-child recovery record remains at %s; keeping the planted binary for detach.\\n' \"$f\" >&2; return 0; fi",
  "  done",
  "  return 1",
  "}",
  "if [ -f \"$dest\" ]; then",
  "  if [ -x \"$dest\" ]; then",
  "    out=$(\"$dest\" detach --purge --json) || exit $?",
  // purged:false from the managed binary means it kept itself on purpose: a relay of another
  // ocx-child home runs from it. Any other answer keeps the old belt-and-braces removal.
  "    case \"$out\" in *'\"purged\":false'*) printf 'ocx-child kept the planted binary: another ocx-child relay runs from it.\\n' >&2; exit 0;; esac",
  "    rm -f \"$dest\" 2>/dev/null || true",
  "  elif recovery_pending; then",
  "    exit 1",
  "  else",
  "    rm -f \"$dest\" 2>/dev/null || true",
  "  fi",
  "elif recovery_pending; then",
  "  exit 1",
  "fi",
  "rmdir \"$HOME/.cache/opencodex/bin\" \"$HOME/.cache/opencodex\" 2>/dev/null || true",
  "exit 0",
].join("\n");

export function remotePurgePlantedChildArgv(platform: "posix" | "windows" = "posix"): string[] {
  return platform === "windows"
    ? windowsPurgePlantedChildArgv()
    : ["sh", "-c", POSIX_PURGE_PLANTED_SCRIPT, "ocx-purge-plant"];
}

/**
 * Runs disconnect through the managed planted binary only. A PATH or ~/.local/bin candidate cannot
 * purge itself (it lives outside the managed directory), so the generic resolver is never used here.
 */
export const POSIX_MANAGED_PURGE_DISCONNECT_SCRIPT = [
  "case \"$(uname -s 2>/dev/null)\" in Windows*|MSYS*|MINGW*|CYGWIN*) exit 125;; esac",
  "for p in \"$HOME/.cache\" \"$HOME/.cache/opencodex\" \"$HOME/.cache/opencodex/bin\" \"$HOME/.cache/opencodex/bin/ocx-child\"; do",
  "  if [ -L \"$p\" ]; then printf 'Refusing symlink in managed plant path: %s\\n' \"$p\" >&2; exit 1; fi",
  "done",
  "dest=\"$HOME/.cache/opencodex/bin/ocx-child\"",
  `if [ ! -f "$dest" ] || [ ! -x "$dest" ]; then printf '${MANAGED_PURGE_CHILD_MISSING_MARKER}\\n' >&2; exit 1; fi`,
  // "$@" is empty for a revoke; ocx link recover passes --expect-link <link id>.
  "exec \"$dest\" disconnect --purge --json \"$@\"",
].join("\n");

const LINK_ID = /^lnk_[0-9a-f]{16}$/;

/**
 * ocx link recover's proof after a lost answer: the link-bound receipt that ocx-child detach
 * --expect-link writes to $OPENCODEX_HOME/link-receipts/<link id>.json once it restored the Child
 * (native/ocx-child/src/cli.rs write_detach_receipt). Read-only; a missing, symlinked or unreadable
 * receipt exits non-zero and proves nothing.
 */
export const POSIX_RECOVER_RECEIPT_SCRIPT = [
  "case \"$(uname -s 2>/dev/null)\" in Windows*|MSYS*|MINGW*|CYGWIN*) exit 125;; esac",
  // The receipt proves the restore; the purge is proven only by a binary confirmed absent. A test
  // for a path reads false both when it is absent and when an ancestor cannot be searched, so each
  // step is trusted only after its parent was shown to be a searchable directory. An existing but
  // non-executable file, or any directory on the way that cannot be searched, proves nothing.
  "prev=\"$HOME\"",
  "for p in \"$HOME/.cache\" \"$HOME/.cache/opencodex\" \"$HOME/.cache/opencodex/bin\" \"$HOME/.cache/opencodex/bin/ocx-child\"; do",
  "  if [ ! -d \"$prev\" ] || [ ! -x \"$prev\" ]; then exit 4; fi",
  "  if [ ! -e \"$p\" ] && [ ! -L \"$p\" ]; then break; fi",
  "  if [ \"$p\" = \"$HOME/.cache/opencodex/bin/ocx-child\" ]; then exit 4; fi",
  "  prev=\"$p\"",
  "done",
  "f=\"${OPENCODEX_HOME:-$HOME/.opencodex}/link-receipts/$1.json\"",
  "if [ -L \"$f\" ] || [ ! -f \"$f\" ] || [ ! -r \"$f\" ]; then exit 4; fi",
  "cat -- \"$f\"",
].join("\n");

export function remoteRecoverReceiptArgv(platform: "posix" | "windows", linkId: string): string[] {
  if (!LINK_ID.test(linkId)) throw new Error("invalid link id");
  return platform === "windows" ? windowsRecoverReceiptArgv(linkId) : ["sh", "-c", POSIX_RECOVER_RECEIPT_SCRIPT, "ocx-recover-receipt", linkId];
}

/** With expectLink, the Child restores only when its state and owner record both name that link. */
export function remoteManagedPurgeDisconnectArgv(platform: "posix" | "windows" = "posix", expectLink?: string): string[] {
  if (expectLink !== undefined && !LINK_ID.test(expectLink)) throw new Error("invalid link id");
  const extra = expectLink === undefined ? [] : ["--expect-link", expectLink];
  return platform === "windows"
    ? windowsManagedPurgeDisconnectArgv(expectLink)
    : ["sh", "-c", POSIX_MANAGED_PURGE_DISCONNECT_SCRIPT, "ocx-managed-purge", ...extra];
}

/** The `purged` flag from `ocx-child disconnect --json`, or null when no such report was printed. */
export function parsePurgeDisconnectReport(stdout: string): boolean | null {
  for (const raw of stdout.split(/\r?\n/).reverse()) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof (parsed as { purged?: unknown }).purged === "boolean") return (parsed as { purged: boolean }).purged;
    } catch { /* not the report line */ }
  }
  return null;
}

/** Printed by ocx-child on stderr when --purge kept the binary because another relay runs from it. */
export const PURGE_KEPT_IN_USE_MARKER = "ocx-purge-kept:binary_in_use";

export type PurgeDisconnectOutcome =
  | { readonly ok: true }
  /** notAttempted: the Child's disconnect never ran (inspection failed, a full install, or no planted binary to run). */
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string; readonly hint?: string; readonly notAttempted?: true };

/**
 * Disconnect with --purge. A link enrolled before childKind existed is inspected first; only an
 * ocx-child Child can be purged, and success requires the binary's own report that it was removed.
 */
export async function purgeDisconnectRemote(
  runner: Pick<SshRunner, "run">,
  alias: string,
  route: ExplicitRoute | null,
  knownHostsFile: string,
  platform: "posix" | "windows",
  childKind: "ephemeral" | "full" | undefined,
  expectLink?: string,
  /** Asked before the unbound retry for a binary older than --expect-link; false refuses it (nothing changed). */
  unboundStillSafe: () => boolean = () => true,
): Promise<PurgeDisconnectOutcome> {
  const failed = (message: string, hint?: string): PurgeDisconnectOutcome => ({ ok: false, status: 502, code: "remote_disconnect_failed", message, ...(hint ? { hint } : {}) });
  const notAttempted = (message: string, hint?: string): PurgeDisconnectOutcome => ({ ok: false, status: 502, code: "remote_disconnect_failed", message, ...(hint ? { hint } : {}), notAttempted: true });
  let kind = childKind;
  if (kind === undefined) {
    let inspected: ParsedRemoteRuntimeInspection | null;
    try { inspected = await inspectRemoteChildRuntime(runner, alias, route, knownHostsFile, platform); } catch (error) { return notAttempted("The Child runtime could not be inspected, so --purge was not attempted.", sshRunnerErrorHint(error) ?? "child_kind_unknown"); }
    if (!inspected || inspected.runtimeKind === "missing") return notAttempted("The Child runtime could not be identified, so --purge was not attempted.", "child_kind_unknown");
    kind = inspected.runtimeKind;
  }
  if (kind !== "ephemeral") {
    return { ok: false, status: 409, code: "purge_unsupported", message: "This Child runs a full OpenCodex install; --purge removes only a planted ocx-child. Disconnect without --purge.", notAttempted: true };
  }
  const purgeArgv = (link?: string) => buildExecArgv({ alias, argv: remoteManagedPurgeDisconnectArgv(platform, link), knownHostsFile, route });
  let result;
  let bound = expectLink !== undefined;
  try { result = await runner.run(purgeArgv(expectLink), { timeoutMs: 30_000 }); } catch (error) { return failed("The remote client could not be disconnected.", sshRunnerErrorHint(error)); }
  // A planted binary older than --expect-link rejects it as a usage error (exit 2) before doing anything: run unbound.
  if (bound && result.code === CHILD_USAGE_EXIT) {
    // The route answers this hint with its own fixed message (BOUND_REFUSAL_MESSAGES in link-routes.ts), which covers a planted
    // ocx-child too, so this text names only what happened.
    if (!unboundStillSafe()) return notAttempted("The planted ocx-child predates --expect-link and another Home-initiated link of this Home may reach the same machine, so it was not purged.", "expect_link_unsupported");
    bound = false;
    try { result = await runner.run(purgeArgv(), { timeoutMs: 30_000 }); } catch (error) { return failed("The remote client could not be disconnected.", sshRunnerErrorHint(error)); }
  }
  // detach --expect-link refused without changing anything: another link owns this Child (5), or it keeps state it
  // cannot restore (6). Only a refusal recognised as such; anything else below counts as a cleanup attempted.
  const refusal = bound ? classifyBoundRefusal(result.code, result.stderr, expectLink!) : null;
  if (refusal === "mismatch" || refusal === "residual") {
    return notAttempted("The Child is not attached to this link, so it was not disconnected.", refusal === "mismatch" ? "child_link_mismatch" : "child_residual");
  }
  if (result.code !== 0) {
    // The script prints the marker and exits before it runs the binary.
    if (result.stderr.includes(MANAGED_PURGE_CHILD_MISSING_MARKER)) return notAttempted("No planted ocx-child was found in the managed directory, so nothing was purged.", "managed_child_missing");
    return failed("The remote client could not be disconnected.", sshFailureHint(result.stderr));
  }
  if (parsePurgeDisconnectReport(result.stdout) !== true) {
    if (result.stderr.includes(PURGE_KEPT_IN_USE_MARKER)) return failed("The Child disconnected, but kept the planted ocx-child because another ocx-child relay runs from it; the link was kept.", "binary_in_use");
    return failed("The Child disconnected but did not report removing the planted ocx-child binary.", "purge_incomplete");
  }
  return { ok: true };
}

/** Exit codes of a Child refusing a link-bound command (ocx-child detach, ocx disconnect --expect-link). */
export const CHILD_USAGE_EXIT = 2;
export const CHILD_EXPECT_CONFLICT_EXIT = 5;
export const CHILD_EXPECT_RESIDUAL_EXIT = 6;

/** Reasons full ocx gives for a link-bound refusal that changed nothing (ClientSyncMismatchReason without disconnect_pending). */
const NO_WRITE_MISMATCH_REASONS = new Set(["disconnected", "invalid_state", "pending_operation", "hub_client", "link_client", "other_link", "other_key", "client_initiated_link"]);

/**
 * What a link-bound refusal (exit 5 or 6) proves, read from the last stderr line only and from a closed set:
 * "mismatch" or "residual" changed nothing on the Child (full ocx's {"phase":"child_link_mismatch","reason"} with a
 * no-write reason, or ocx-child's "detach --expect-link <this link> refused (conflict|residual)"); "pending" is an
 * unfinished disconnect the Child could not bind to this link, so an earlier attempt may have cleaned part of it. Any
 * other answer (an unknown reason, garbled or extra output) is null: the caller treats it as a cleanup attempted.
 */
export function classifyBoundRefusal(code: number, stderr: string, linkId: string): "mismatch" | "residual" | "pending" | null {
  if (code !== CHILD_EXPECT_CONFLICT_EXIT && code !== CHILD_EXPECT_RESIDUAL_EXIT) return null;
  const line = stderr.trim().split(/\r?\n/).at(-1) ?? "";
  const childLine = (outcome: "conflict" | "residual") => line.startsWith("detach --expect-link " + linkId + " refused (" + outcome + "): ");
  if (code === CHILD_EXPECT_RESIDUAL_EXIT) return childLine("residual") ? "residual" : null;
  if (childLine("conflict")) return "mismatch";
  if (!line.startsWith("{")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { phase, reason } = parsed as { phase?: unknown; reason?: unknown };
  if (phase !== "child_link_mismatch" || typeof reason !== "string") return null;
  if (reason === "disconnect_pending") return "pending";
  return NO_WRITE_MISMATCH_REASONS.has(reason) ? "mismatch" : null;
}

/** The distinct reason a plant failed on the Child, when the plant script reported one. */
export function classifyPlantFailure(stderr: string): "hash_tool_unavailable" | null {
  return stderr.includes(PLANT_HASH_TOOL_UNAVAILABLE_MARKER) ? "hash_tool_unavailable" : null;
}

export function classifyChildAttachConflict(stderr: string): ChildAttachConflictCode | null {
  if (stderr.includes("ocx-child-conflict:child_port_busy:")) return "child_port_busy";
  if (stderr.includes("ocx-child-conflict:child_external_provider_conflict:")) return "child_external_provider_conflict";
  return null;
}


/**
 * --require-ephemeral (structure/remote-link.md, "Operation journal"): every full ocx the gated argv could select,
 * the served-runtime census, the Desktop and system paths and every PATH directory, each counted when it answers
 * --version. Unlike runtime inspection it never stops at an ocx-child, so a Child holding both reports the full one.
 * Prints ocx-census:full per runnable full ocx, then ocx-census:done.
 */
export const POSIX_FULL_INSTALL_CENSUS_SCRIPT = [
  "export PATH=\"$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin\"",
  "case \"$(uname -s 2>/dev/null)\" in Windows*|MSYS*|MINGW*|CYGWIN*) exit 125;; esac",
  "ocx_entry=",
  "census_full() {",
  "  if [ -x \"$1\" ] && \"$1\" ${ocx_entry:+\"$ocx_entry\"} --version >/dev/null 2>&1; then printf '%s\\n' 'ocx-census:full'; fi",
  "}",
  REMOTE_SERVED_RUNTIME.trimEnd(),
  remoteServedRuntimeAttempt("census_full \"$served_bin\""),
  "for candidate in \"$HOME/.opencodex-desktop/bin/ocx\" \"/Applications/OpenCodex.app/Contents/MacOS/ocx\" \"/usr/bin/ocx\"; do",
  "  census_full \"$candidate\"",
  "done",
  "remaining=$PATH",
  "while :; do",
  "  directory=${remaining%%:*}",
  "  census_full \"${directory:-.}/ocx\"",
  "  case \"$remaining\" in *:*) remaining=${remaining#*:};; *) break;; esac",
  "done",
  "printf '%s\\n' 'ocx-census:done'",
].join("\n");

export function remoteFullInstallCensusArgv(): string[] {
  return ["sh", "-c", POSIX_FULL_INSTALL_CENSUS_SCRIPT, "ocx-census"];
}

/** present or none only after the closing marker; anything else is unknown (null) and refuses. */
export function parseFullInstallCensus(stdout: string): "present" | "none" | null {
  const lines = stdout.split(/\r?\n/).map(line => line.trim());
  if (!lines.includes("ocx-census:done")) return null;
  return lines.includes("ocx-census:full") ? "present" : "none";
}
