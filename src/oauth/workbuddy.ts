import type { OAuthController, OAuthCredentials } from "./types";
import {
  readWorkBuddySessionSnapshot,
  resolveWorkBuddyAuthFilePath,
  runtimeWorkBuddyNativeInputs,
  workBuddySessionToCredential,
  type WorkBuddyNativeInputs,
} from "./workbuddy-credentials";

export interface WorkBuddyLoginOptions {
  /** Add-account flows must not silently reimport the current desktop session. */
  importLocal?: "fallback" | "off";
}

export function shouldImportLocalWorkBuddyAuth(options: WorkBuddyLoginOptions = {}): boolean {
  return options.importLocal !== "off";
}

function nativeInputs(): WorkBuddyNativeInputs {
  return runtimeWorkBuddyNativeInputs();
}

export function importLocalWorkBuddyAuth(inputs: WorkBuddyNativeInputs = nativeInputs()): OAuthCredentials | null {
  const snapshot = readWorkBuddySessionSnapshot(inputs);
  return snapshot ? workBuddySessionToCredential(snapshot) : null;
}

export function workBuddyLoginGuidance(inputs: WorkBuddyNativeInputs = nativeInputs()): string {
  return `Sign in to the WorkBuddy desktop app, then run \`ocx login workbuddy\` to import the session from ${resolveWorkBuddyAuthFilePath(inputs)}.`;
}

export async function loginWorkBuddy(
  ctrl: OAuthController,
  options: WorkBuddyLoginOptions = {},
): Promise<OAuthCredentials> {
  if (ctrl.signal?.aborted) {
    throw ctrl.signal.reason ?? new DOMException("WorkBuddy login aborted", "AbortError");
  }
  if (shouldImportLocalWorkBuddyAuth(options)) {
    const local = importLocalWorkBuddyAuth();
    if (local) {
      ctrl.onProgress?.("Imported WorkBuddy desktop session.");
      return local;
    }
  }
  throw new Error(
    `WorkBuddy desktop session not found. ${workBuddyLoginGuidance()}`,
  );
}

export async function refreshWorkBuddyToken(
  _refreshToken: string,
  signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("WorkBuddy refresh aborted", "AbortError");
  }
  const fresh = importLocalWorkBuddyAuth();
  if (!fresh) {
    throw new Error(`WorkBuddy desktop session missing. ${workBuddyLoginGuidance()}`);
  }
  if (credential?.accountId && fresh.accountId && credential.accountId !== fresh.accountId) {
    throw new Error("WorkBuddy desktop session belongs to a different account; run ocx login workbuddy");
  }
  return fresh;
}

/** Convenience for tests that need a stable home without touching the real auth file. */
export function workBuddyNativeInputsForHome(home: string, platform: NodeJS.Platform = process.platform): WorkBuddyNativeInputs {
  return {
    env: { ...process.env, HOME: platform === "win32" ? undefined : home, USERPROFILE: platform === "win32" ? home : undefined },
    platform,
    home,
  };
}
