/** Public, allowlisted browser boundary for the existing native-main API. */
export interface NativeMainProfile {
  id: string;
  label: string;
  identityHint: string;
  state: "active" | "inactive";
}
export interface NativeMainList {
  effectiveCodexHome: string;
  activeProfileId: string | null;
  profiles: NativeMainProfile[];
}
export interface NativeMainDoctor {
  effectiveCodexHome: string;
  activeProfileId: string | null;
  supported: boolean;
  authStatus: "ok" | "missing" | "invalid" | "unreadable";
  keyStore: "available" | "missing-key" | "unavailable";
  vaultStatus: "ok" | "missing" | "invalid";
  recoveryPending: boolean;
}
export interface NativeMainSnapshot {
  doctor: NativeMainDoctor;
  list: NativeMainList | null;
}
export type NativeMainAction =
  | { kind: "switch"; target: string; label: string }
  | { kind: "recover"; rollback: boolean };
export interface NativeMainResult {
  effectiveCodexHome: string;
  restartRequired: boolean;
  recovered?: boolean;
}

const codes = [
  "INVALID_REQUEST", "CODEX_HOME_UNAVAILABLE", "UNSUPPORTED_AUTH_STORE", "AUTH_MISSING",
  "AUTH_INVALID", "AUTH_UNREADABLE", "AUTH_TEMP_CLEANUP_REQUIRED", "ACTIVE_PROFILE_MISMATCH",
  "PROFILE_NOT_FOUND", "PROFILE_ALREADY_EXISTS", "PROFILE_DECRYPT_FAILED", "KEYRING_UNAVAILABLE",
  "KEYRING_KEY_MISSING", "PROFILE_LOCK_UNAVAILABLE", "NATIVE_PROFILE_BUSY", "NATIVE_MAIN_OWNER_BUSY",
  "NATIVE_MAIN_OWNER_UNAVAILABLE", "NATIVE_MAIN_CLAIM_BUSY", "NATIVE_MAIN_CLAIM_UNAVAILABLE",
  "CODEX_BUSY", "CODEX_PROCESS_CHECK_UNAVAILABLE", "MAIN_REQUESTS_ACTIVE", "RECOVERY_REQUIRED",
  "AUTH_RESTORE_FAILED", "SWITCH_ROLLED_BACK", "PROFILE_METADATA_TOO_LARGE", "PROFILE_STORAGE_UNSAFE",
  "LEGACY_PROFILE_STATE", "INTERNAL_ERROR", "VAULT_INVALID", "STAGING_CLEANUP_REQUIRED",
  "NETWORK_ERROR", "INVALID_RESPONSE", "STATE_CHANGED",
] as const;
export type NativeMainErrorCode = typeof codes[number];
export class NativeMainError extends Error {
  readonly code: NativeMainErrorCode;
  constructor(code: NativeMainErrorCode) {
    super(code);
    this.code = code;
  }
}
export function nativeMainErrorCode(error: unknown): NativeMainErrorCode {
  return error instanceof NativeMainError ? error.code : "NETWORK_ERROR";
}
function invalid(): never { throw new NativeMainError("INVALID_RESPONSE"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalid();
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : invalid();
}
function profile(value: unknown): NativeMainProfile {
  const v = record(value);
  return {
    id: text(v.id), label: text(v.label), identityHint: text(v.identityHint),
    state: choice(v.state, ["active", "inactive"]),
  };
}
export function parseNativeMainList(value: unknown): NativeMainList {
  const v = record(value);
  if (!Array.isArray(v.profiles) || v.profiles.length > 32) return invalid();
  const profiles = v.profiles.map(profile);
  const activeProfileId = nullableText(v.activeProfileId);
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) return invalid();
  const active = profiles.filter(p => p.state === "active");
  if (activeProfileId === null ? profiles.length !== 0 : active.length !== 1 || active[0].id !== activeProfileId) return invalid();
  return { effectiveCodexHome: text(v.effectiveCodexHome), activeProfileId, profiles };
}
export function parseNativeMainDoctor(value: unknown): NativeMainDoctor {
  const v = record(value);
  return {
    effectiveCodexHome: text(v.effectiveCodexHome), activeProfileId: nullableText(v.activeProfileId),
    supported: bool(v.supported), authStatus: choice(v.authStatus, ["ok", "missing", "invalid", "unreadable"]),
    keyStore: choice(v.keyStore, ["available", "missing-key", "unavailable"]),
    vaultStatus: choice(v.vaultStatus, ["ok", "missing", "invalid"]), recoveryPending: bool(v.recoveryPending),
  };
}
async function request(
  apiBase: string, suffix: string, signal: AbortSignal, body?: object, fetchImpl?: typeof fetch,
): Promise<unknown> {
  signal.throwIfAborted();
  // fetchImpl is the GUI-session/CSRF/auth boundary: the dashboard installs it
  // as the global fetch wrapper, tests inject a fixture. Do not add tokens or
  // display response/error bodies. Never persist profile state.
  const response = await (fetchImpl ?? fetch)(`${apiBase}/api/native-main-profiles${suffix}`, {
    method: body ? "POST" : "GET", signal, cache: "no-store",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let value: unknown;
  try { value = await response.json(); } catch { throw new NativeMainError("INVALID_RESPONSE"); }
  signal.throwIfAborted();
  if (!response.ok) {
    const code = value && typeof value === "object" ? (value as Record<string, unknown>).code : undefined;
    throw new NativeMainError(typeof code === "string" && codes.includes(code as NativeMainErrorCode)
      ? code as NativeMainErrorCode : "INTERNAL_ERROR");
  }
  return value;
}
export async function readNativeMainSnapshot(
  apiBase: string, signal: AbortSignal, fetchImpl?: typeof fetch,
): Promise<NativeMainSnapshot> {
  // A broken vault can make list fail while doctor still permits recovery.
  const [list, doctor] = await Promise.allSettled([
    request(apiBase, "", signal, undefined, fetchImpl).then(parseNativeMainList),
    request(apiBase, "/doctor", signal, undefined, fetchImpl).then(parseNativeMainDoctor),
  ]);
  signal.throwIfAborted();
  if (doctor.status === "rejected") throw doctor.reason;
  if (list.status === "rejected") {
    if (!doctor.value.recoveryPending) throw list.reason;
    return { doctor: doctor.value, list: null };
  }
  if (list.value.effectiveCodexHome !== doctor.value.effectiveCodexHome
    || list.value.activeProfileId !== doctor.value.activeProfileId) throw new NativeMainError("STATE_CHANGED");
  return { doctor: doctor.value, list: list.value };
}
export function nativeMainUnavailableCode(s: NativeMainSnapshot): NativeMainErrorCode | null {
  const d = s.doctor;
  if (!d.supported) return "UNSUPPORTED_AUTH_STORE";
  if (d.recoveryPending) return "RECOVERY_REQUIRED";
  if (d.authStatus !== "ok") return d.authStatus === "missing" ? "AUTH_MISSING"
    : d.authStatus === "invalid" ? "AUTH_INVALID" : "AUTH_UNREADABLE";
  if (d.keyStore !== "available") return d.keyStore === "missing-key" ? "KEYRING_KEY_MISSING" : "KEYRING_UNAVAILABLE";
  if (d.vaultStatus === "invalid") return "VAULT_INVALID";
  return null;
}
export function canRegisterNativeMain(s: NativeMainSnapshot): boolean {
  const d = s.doctor;
  return !!s.list && d.supported && d.authStatus === "ok" && d.keyStore === "available"
    && d.vaultStatus !== "invalid" && !d.recoveryPending;
}
export function canApplyNativeMain(s: NativeMainSnapshot, action: NativeMainAction): boolean {
  const d = s.doctor;
  if (!d.supported) return false;
  if (action.kind === "recover") return d.recoveryPending;
  return canRegisterNativeMain(s) && !!s.list?.profiles.some(p =>
    p.id === action.target && p.label === action.label && p.state === "inactive");
}
export function sameNativeMainScope(a: NativeMainSnapshot, b: NativeMainSnapshot): boolean {
  return a.doctor.effectiveCodexHome === b.doctor.effectiveCodexHome
    && a.doctor.activeProfileId === b.doctor.activeProfileId
    && a.doctor.recoveryPending === b.doctor.recoveryPending;
}
export async function registerNativeMain(
  apiBase: string, label: string, signal: AbortSignal, fetchImpl?: typeof fetch,
): Promise<string> {
  const v = record(await request(apiBase, "/register", signal, { label: label.trim() }, fetchImpl));
  const home = text(v.effectiveCodexHome);
  if (profile(v.profile).state !== "active") return invalid();
  return home;
}
export async function applyNativeMain(
  apiBase: string, action: NativeMainAction, confirmedStopped: boolean, signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<NativeMainResult> {
  if (!confirmedStopped) throw new NativeMainError("INVALID_REQUEST");
  const v = record(await request(apiBase, action.kind === "switch" ? "/switch" : "/recover", signal,
    action.kind === "switch" ? { target: action.target, confirmedStopped: true }
      : { rollback: action.rollback, confirmedStopped: true }, fetchImpl));
  if (v.ok !== true) return invalid();
  if (action.kind === "switch") {
    const active = profile(v.activeProfile);
    if (active.id !== action.target || active.state !== "active") return invalid();
  }
  // The existing API omits restartRequired for a no-op recovery.
  const restartRequired = action.kind === "recover" && v.restartRequired === undefined && v.recovered === false
    ? false : bool(v.restartRequired);
  return { effectiveCodexHome: text(v.effectiveCodexHome), restartRequired,
    ...(typeof v.recovered === "boolean" ? { recovered: v.recovered } : {}) };
}
