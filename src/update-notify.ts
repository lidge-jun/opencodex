import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { atomicWriteFile, getConfigDir } from "./config";
import { hasStarPromptRun } from "./star-prompt";
import {
  type Channel,
  currentVersion,
  detectInstall,
  latestVersion,
  runUpdate,
  updateCommandStr,
  updateTag,
} from "./update";

const VERSION_FILENAME = "version.json";
const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20h, matching codex-rs
const RELEASE_NOTES_URL = "https://github.com/lidge-jun/opencodex/releases/latest";

export interface VersionCache {
  latest_version: string;
  /** ISO-8601 (RFC3339) timestamp of the last successful registry check. */
  last_checked_at: string;
  dismissed_version?: string;
  tag: Channel;
}

function versionFilePath(): string {
  return join(getConfigDir(), VERSION_FILENAME);
}

/**
 * Read the cached version info. Returns null on any error or when the cached
 * channel differs from the current one (so a stable<->preview switch re-fetches
 * instead of comparing across channels).
 */
export function readVersionCache(channel: Channel): VersionCache | null {
  try {
    const raw = readFileSync(versionFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<VersionCache>;
    if (typeof parsed.latest_version !== "string" || typeof parsed.last_checked_at !== "string") return null;
    if (parsed.tag !== channel) return null;
    return {
      latest_version: parsed.latest_version,
      last_checked_at: parsed.last_checked_at,
      dismissed_version: typeof parsed.dismissed_version === "string" ? parsed.dismissed_version : undefined,
      tag: parsed.tag,
    };
  } catch {
    return null;
  }
}

export function writeVersionCache(cache: VersionCache): void {
  try {
    atomicWriteFile(versionFilePath(), `${JSON.stringify(cache)}\n`);
  } catch {
    /* best-effort; never block startup */
  }
}

function parseStable(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function parsePreview(v: string): [number, number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)-preview\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

function gt(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

/**
 * Channel-aware "is latest newer than current?".
 * - latest channel: compare maj.min.pat only; prereleases are never "newer"
 *   (parity with codex-rs), so stable users are not pushed onto previews.
 * - preview channel: preview-vs-preview compares the trailing -preview.N; a
 *   stable release with a strictly higher base counts as newer (O3), while a
 *   stable release with the same base as the current preview does not.
 */
export function isNewer(latest: string, current: string, channel: Channel): boolean {
  if (channel === "latest") {
    const l = parseStable(latest);
    const c = parseStable(current);
    if (!l || !c) return false;
    return gt(l, c);
  }
  // preview channel
  const lPre = parsePreview(latest);
  const cPre = parsePreview(current);
  if (lPre && cPre) return gt(lPre, cPre);

  const lStable = parseStable(latest);
  if (lStable && cPre) {
    // Stable release vs current preview: newer only if the base is strictly
    // higher than the preview's base (equal base would be a downgrade nag).
    return gt(lStable, [cPre[0], cPre[1], cPre[2]]);
  }
  const cStable = parseStable(current);
  if (lStable && cStable) return gt(lStable, cStable);
  return false;
}

export function isSourceBuildVersion(v: string): boolean {
  return v.trim() === "0.0.0";
}

/** The interactive/TTY + install-method gate shared with the star prompt. */
function interactiveGuardOk(): boolean {
  return !(process.env.OCX_SERVICE || !process.stdin.isTTY || !process.stdout.isTTY);
}

/**
 * Decide whether this run should even consider showing the prompt. Returns the
 * channel + current version when eligible, else null. Eligibility requires a
 * real global install, a non-source version, the interactive guard, and that
 * the one-time star prompt has already run (first-run yield, O1).
 */
export function shouldConsider(): { channel: Channel; current: string } | null {
  if (detectInstall() === "source") return null;
  const current = currentVersion();
  if (current === "?" || isSourceBuildVersion(current)) return null;
  if (!interactiveGuardOk()) return null;
  if (!hasStarPromptRun()) return null; // yield on the very first run
  return { channel: updateTag(current), current };
}

/** The cached upgrade version to surface, honoring the user's dismissal. */
export function getUpgradeVersionForPopup(
  cache: VersionCache | null,
  current: string,
  channel: Channel,
): string | null {
  if (!cache) return null;
  if (!isNewer(cache.latest_version, current, channel)) return null;
  if (cache.dismissed_version === cache.latest_version) return null;
  return cache.latest_version;
}

function cacheIsStale(cache: VersionCache | null): boolean {
  if (!cache) return true;
  const checked = Date.parse(cache.last_checked_at);
  if (!Number.isFinite(checked)) return true;
  return Date.now() - checked > REFRESH_INTERVAL_MS;
}

/**
 * If the cache is missing or older than 20h, kick off a detached helper to
 * refresh it without blocking this (soon-to-be daemon) process. Fire-and-forget.
 */
export function triggerBackgroundRefreshIfStale(channel: Channel, cache: VersionCache | null): void {
  if (!cacheIsStale(cache)) return;
  try {
    const entry = process.argv[1];
    if (!entry || !existsSync(entry)) return;
    const child = spawn(process.execPath, [entry, "__refresh-version", channel], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, OCX_SERVICE: "1" }, // never let the helper prompt
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}

/**
 * Body of the hidden `__refresh-version` subcommand: fetch the latest version
 * for the channel and persist it. Only advances `last_checked_at` on success so
 * a failed fetch retries on the next start.
 */
export async function refreshVersionCache(channel: Channel): Promise<void> {
  const latest = latestVersion(channel);
  if (!latest) return; // do not dirty the cache or advance the timestamp
  const prev = readVersionCache(channel);
  writeVersionCache({
    latest_version: latest,
    last_checked_at: new Date().toISOString(),
    dismissed_version: prev?.dismissed_version,
    tag: channel,
  });
}

/** Persist a dismissal so this exact version stops prompting. */
function dismissVersion(channel: Channel, version: string): void {
  const cache = readVersionCache(channel);
  if (!cache) return;
  writeVersionCache({ ...cache, dismissed_version: version });
}

function renderPrompt(current: string, latest: string, channel: Channel): string {
  const command = updateCommandStr(detectInstall(), channel);
  return [
    "",
    `  \x1b[38;5;141m✨ Update available!\x1b[0m  \x1b[2m${current} -> ${latest}\x1b[0m`,
    "",
    `  \x1b[2mRelease notes:\x1b[0m ${RELEASE_NOTES_URL}`,
    "",
    `  1) Update now (runs \`${command}\`)`,
    "  2) Skip",
    "  3) Skip until next version",
    "",
    "  [1/2/3] (default 1): ",
  ].join("\n");
}

/**
 * Interactive-only update prompt for `ocx start`. Must be called BEFORE the
 * server binds a port / writes a PID, because "Update now" installs globally
 * and exits. No-op for service/daemon/non-TTY runs and source checkouts.
 * Never throws.
 */
export async function maybeShowUpdatePrompt(): Promise<void> {
  try {
    const eligible = shouldConsider();
    if (!eligible) return;
    const { channel, current } = eligible;

    const cache = readVersionCache(channel);
    triggerBackgroundRefreshIfStale(channel, cache);

    const latest = getUpgradeVersionForPopup(cache, current, channel);
    if (!latest) return;

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer = "";
    try {
      answer = (await rl.question(renderPrompt(current, latest, channel))).trim();
    } finally {
      rl.close();
    }

    const choice = answer === "" ? "1" : answer;
    if (choice === "1") {
      await runUpdate();
      console.log("\nRestart the proxy:  ocx start");
      process.exit(0);
    } else if (choice === "3") {
      dismissVersion(channel, latest);
    }
    // "2" (or anything else) -> Skip: continue this run unchanged.
  } catch {
    /* never let the update prompt disrupt startup */
  }
}
