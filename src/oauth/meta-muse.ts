/**
 * Meta Muse Code credential import.
 *
 * The Muse Code CLI signs in through a browser device-approval flow and stores the
 * result in two places: `~/.config/muse/auth.json` is a POINTER carrying no secret, and
 * the secret itself lives in the macOS Keychain under service
 * `ai.meta.dev.credentials`, account `meta`.
 *
 * Two measured facts shape this module (devlog/_plan/260903_muse_spark_plan_oauth/003):
 *
 * 1. The Keychain payload holds BOTH an `access_token` and an `api_key`, and only the
 *    `api_key` authenticates the Model API — the OAuth access token returns 401
 *    `invalid_api_key`. So this is a static-key credential, not a refreshable one.
 * 2. Meta scopes that credential to the Muse Code CLI in writing. Reusing it here is an
 *    UNSUPPORTED path the repository owner opted into deliberately, which is why the
 *    warning below fires before anything is read and why the provider sits in the GUI's
 *    HIGH_RISK ToS map.
 *
 * This module never spawns the CLI. A login that finds no credential explains what to
 * run rather than running it: `muse login` is interactive with no machine-readable mode,
 * so a spawned child could outlive cancellation, and polling for the pointer file would
 * be satisfied instantly by the one already on disk — reimporting the OLD account on a
 * force-login.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeApiKeyValue } from "../providers/api-keys";
import type { OAuthController, OAuthCredentials } from "./types";

const MUSE_POINTER_PATH = join(homedir(), ".config", "muse", "auth.json");
const KEYCHAIN_SERVICE = "ai.meta.dev.credentials";
const KEYCHAIN_ACCOUNT = "meta";
const MODELS_URL = "https://api.meta.ai/v1/models";
const VALIDATE_TIMEOUT_MS = 10_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;

/**
 * Shown BEFORE any credential is read.
 *
 * `login-cli.ts` passes `onProgress` straight to `console.log` and never reads the
 * registry note, so this is the CLI's only warning surface. The GUI ignores it because
 * `OAuthTosWarningModal` has already been acknowledged by then.
 */
const CONSENT_WARNING = [
  "Meta scopes the Muse Code credential to the Muse Code CLI.",
  "Using it here is UNSUPPORTED: Meta does not authorize subscription coverage outside its own CLI,",
  "how these calls settle is not observable from the API, and you should treat every call as billable.",
  "The key you import or paste is copied into OpenCodex's auth store (~/.opencodex/auth.json, 0600).",
  "Supported alternative: the meta-model provider with your own key (META_MODEL_API_KEY).",
].join(" ");

/** The Keychain payload. `access_token` is deliberately unused — it 401s (003 §B). */
interface MuseKeychainSecret {
  api_key?: unknown;
  access_token?: unknown;
}

interface MusePointer {
  providers?: { meta?: { mechanism?: unknown; storage?: unknown; user_email?: unknown } };
}

/** Injected so tests never touch the real Keychain, filesystem, platform, or network. */
export interface MuseImportDeps {
  platform?: string;
  readPointer?: () => Promise<string | null>;
  readKeychain?: (signal?: AbortSignal) => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

async function defaultReadPointer(): Promise<string | null> {
  try {
    return await Bun.file(MUSE_POINTER_PATH).text();
  } catch {
    return null;
  }
}

/**
 * `security` can block indefinitely — the Keychain may raise an interactive approval
 * prompt, and on a headless or locked machine nobody answers it. Without a deadline the
 * login would hang before the validation timeout below is even created, so the bound
 * lives here rather than only around the fetch.
 */
async function defaultReadKeychain(signal?: AbortSignal): Promise<string | null> {
  const deadline = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(KEYCHAIN_TIMEOUT_MS)])
    : AbortSignal.timeout(KEYCHAIN_TIMEOUT_MS);
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    proc = Bun.spawn(
      ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const child = proc;
    const finished = Promise.all([new Response(child.stdout).text(), child.exited]);
    const timedOut = new Promise<null>((resolve) => {
      if (deadline.aborted) { resolve(null); return; }
      deadline.addEventListener("abort", () => resolve(null), { once: true });
    });
    const settled = await Promise.race([finished, timedOut]);
    if (settled === null) return null;
    const [out, code] = settled;
    if (code !== 0) return null;
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  } finally {
    // A prompt still on screen keeps the child alive after the race resolves.
    if (proc && proc.exitCode === null) { try { proc.kill(); } catch { /* already gone */ } }
  }
}

const INSTALL_HINT =
  "Install it from https://dev.meta.ai/install.sh, run `muse login`, then retry.";

/**
 * Where a user without the CLI gets a key by hand.
 *
 * The Muse Code API key is visible in Meta's own developer console, so a host with no
 * CLI is not out of options ??it is out of an IMPORT path. That distinction is the whole
 * reason this branch exists: refusing a platform because our importer cannot read its
 * store, while the vendor hands the same key to the user in a browser, is a limitation
 * of the importer being reported as a limitation of the platform.
 */
const MANUAL_KEY_URL = "https://dev.meta.ai";

/**
 * Accept a hand-entered Muse Code API key.
 *
 * Every guarantee the import path makes still holds here, because they are enforced
 * BELOW this function rather than inside it: the same `LLM|` grammar check, the same
 * live validation against the Model API, and the same consent warning, which has
 * already fired before any of this runs. What is missing is only the pointer, so the
 * credential carries no email and `source` is `manual` rather than `local-cli`.
 */
async function manualKeyCredential(
  ctrl: OAuthController,
  reason: string,
): Promise<string | null> {
  if (!ctrl.onManualCodeInput) return null;
  // Resolve the login flow first so the GUI renders its paste field; otherwise
  // onManualCodeInput blocks and the dashboard never sees a response (kiro.ts:405).
  ctrl.onAuth?.({
    url: MANUAL_KEY_URL,
    instructions:
      `${reason} Sign in at ${MANUAL_KEY_URL}, copy your Muse Code API key, and paste it below.`,
  });
  ctrl.onProgress?.(`Paste a Muse Code API key from ${MANUAL_KEY_URL} (it starts with "LLM|").`);
  const pasted = (await ctrl.onManualCodeInput()).trim();
  return pasted.length > 0 ? pasted : null;
}

function normalizedEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Import the credential the Muse Code CLI already holds.
 *
 * Every refusal names what the user should do. None of them includes the credential.
 */
export async function loginMetaMuse(
  ctrl: OAuthController = {},
  deps: MuseImportDeps = {},
): Promise<OAuthCredentials> {
  // Before ANY read: the CLI has no other warning surface.
  ctrl.onProgress?.(CONSENT_WARNING);

  const platform = deps.platform ?? process.platform;
  // Off darwin there is no store this importer can read: Meta ships no native Windows
  // CLI, and the Linux credential shape has never been measured. That is a limitation
  // of the IMPORT, not of the platform ??the same key is visible in Meta's console ??
  // so these hosts get a paste field instead of a dead end. The pasted key then goes
  // through the identical grammar check and live validation as an imported one.
  if (platform !== "darwin") {
    // The two platforms are unavailable for DIFFERENT reasons, and saying so matters:
    // Meta ships no Windows build at all, while the Linux CLI exists and only its
    // credential storage is unmeasured. Collapsing them into "no CLI here" would tell
    // a Linux user something false about their own machine.
    const reason = platform === "win32"
      ? "Meta ships no native Windows Muse Code CLI, so there is no credential to import."
      : "The Muse Code CLI runs here, but where it stores its credential has not been measured, "
        + "so importing one is refused rather than guessed.";
    const pasted = await manualKeyCredential(ctrl, reason);
    if (pasted === null) {
      throw new Error(
        `${reason} This client cannot prompt for a key, so run \`ocx login meta-muse\` from the CLI `
          + `or the dashboard and paste yours from ${MANUAL_KEY_URL}, `
          + "or use the meta-model provider with your own key (META_MODEL_API_KEY).",
      );
    }
    return await validatedMetaMuseCredential(pasted, ctrl, deps, undefined, "manual");
  }

  const pointerRaw = await (deps.readPointer ?? defaultReadPointer)();
  if (pointerRaw === null) {
    throw new Error(`Muse Code CLI credential not found at ${MUSE_POINTER_PATH}. ${INSTALL_HINT}`);
  }

  let pointer: MusePointer;
  try {
    pointer = JSON.parse(pointerRaw) as MusePointer;
  } catch {
    throw new Error(`Muse Code credential file at ${MUSE_POINTER_PATH} is not valid JSON. Run \`muse login\` to rewrite it.`);
  }

  const meta = pointer.providers?.meta;
  if (!meta || meta.mechanism !== "oauth") {
    throw new Error("The Muse Code credential file has no signed-in Meta account. Run `muse login`, then retry.");
  }
  // A different storage backend is a shape we have not measured; refuse rather than guess.
  if (meta.storage !== "keychain") {
    throw new Error(
      `Muse Code stored its credential with an unsupported backend (${String(meta.storage)}); only the macOS Keychain is verified.`,
    );
  }

  const secretRaw = await (deps.readKeychain ?? defaultReadKeychain)(ctrl.signal);
  if (secretRaw === null) {
    throw new Error(
      "Could not read the Muse Code credential from the macOS Keychain within 5s. Approve the Keychain prompt, or run `muse login` again.",
    );
  }

  let secret: MuseKeychainSecret;
  try {
    secret = JSON.parse(secretRaw) as MuseKeychainSecret;
  } catch {
    throw new Error("The Muse Code Keychain entry is not valid JSON. Run `muse login` to rewrite it.");
  }

  // access_token is present but 401s against the Model API (003 §B) — never fall back to it.
  return await validatedMetaMuseCredential(
    secret.api_key,
    ctrl,
    deps,
    normalizedEmail(meta.user_email),
    "local-cli",
  );
}

/**
 * The single gate every credential passes, imported or pasted.
 *
 * Both paths share it deliberately. A pasted key that skipped the grammar check or the
 * live validation would be a weaker credential wearing the same provider id, and the
 * difference would surface only as a 401 in the middle of a session.
 */
async function validatedMetaMuseCredential(
  candidate: unknown,
  ctrl: OAuthController,
  deps: MuseImportDeps,
  email: string | undefined,
  source: "local-cli" | "manual",
): Promise<OAuthCredentials> {
  const retry = source === "manual"
    ? `Copy it again from ${MANUAL_KEY_URL}.`
    : "Run `muse login` again.";
  const apiKey = sanitizeApiKeyValue(candidate);
  if (!apiKey) {
    // The macOS wording is preserved verbatim. Extraction is a refactor, and a refactor
    // that quietly rewrites a user-facing error is a behavior change in disguise.
    throw new Error(source === "manual"
      ? `The pasted Muse Code credential carries no usable API key. ${retry}`
      : "The Muse Code Keychain entry carries no usable API key. Run `muse login` again.");
  }
  if (!/^LLM\|\d+\|[A-Za-z0-9_-]{10,}$/.test(apiKey)) {
    throw new Error(source === "manual"
      ? `The pasted Muse Code credential is not in the expected Meta API key format. ${retry}`
      : "The Muse Code credential is not in the expected Meta API key format. Run `muse login` again.");
  }
  ctrl.onProgress?.(source === "manual"
    ? "Validating the pasted Meta credential..."
    : "Validating the imported Meta credential...");
  const fetchImpl = deps.fetchImpl ?? fetch;
  // ctrl.signal is OPTIONAL and the CLI controller supplies none: AbortSignal.any([undefined])
  // throws a TypeError, which would fail every CLI login right after the warning printed.
  const signal = ctrl.signal
    ? AbortSignal.any([ctrl.signal, AbortSignal.timeout(VALIDATE_TIMEOUT_MS)])
    : AbortSignal.timeout(VALIDATE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (ctrl.signal?.aborted) throw ctrl.signal.reason ?? new DOMException("Meta Muse login aborted", "AbortError");
    throw new Error(`Could not reach the Meta Model API to validate the credential: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(
      `The Muse Code credential was rejected by the Meta Model API (HTTP ${response.status}). ${retry}`,
    );
  }

  return {
    access: apiKey,
    // Static key: there is nothing to exchange, so refresh carries the same value.
    refresh: apiKey,
    expires: Number.MAX_SAFE_INTEGER,
    // `email`, not `accountId`: the account list masks email for display, and store.ts
    // already falls back to it for slot identity, so multi-account still works.
    ...(email ? { email } : {}),
    source,
  };
}

/**
 * Static-key refresh, exactly like Command Code's.
 *
 * This deliberately does NOT re-read the Keychain. Generic refresh writes its result into
 * the slot being refreshed, so if the user ran `muse login` with a DIFFERENT account in
 * between, a re-import would silently overwrite one stored identity with another. Only an
 * explicit login may import.
 *
 * It also does not assert a source. `merged()` in index.ts keeps the previous source for
 * anything that is not `local-cli`, so returning `local-cli` here would relabel a
 * hand-pasted key as an imported one on its first refresh and misreport where the
 * credential came from.
 */
export async function refreshMetaMuseToken(
  apiKey: string,
  _signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (!apiKey) throw new Error("Meta Muse Code API key missing; run `ocx login meta-muse`");
  return {
    access: apiKey,
    refresh: apiKey,
    expires: Number.MAX_SAFE_INTEGER,
    source: credential?.source === "manual" ? "manual" : "local-cli",
  };
}
