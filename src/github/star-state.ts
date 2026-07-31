/**
 * GitHub star state for the GUI sidebar star control.
 *
 * Starring goes through the user's own `gh` login — opencodex never holds a
 * GitHub token of its own. That makes three states possible, and the sidebar
 * needs to tell them apart:
 *
 * - `starred` / `not-starred` — `gh` is authenticated and answered.
 * - `unauthenticated` — `gh` is missing or logged out, so a click cannot star.
 *   The control still links out to the repository page in that case.
 *
 * Every `gh` invocation is a process spawn, so reads are cached. A star write
 * invalidates the cache immediately, which is why the click path never has to
 * wait for the TTL to see its own result.
 */
import { commandInvocation } from "../lib/win-exec";

export const STAR_REPO = "lidge-jun/opencodex";
export const STAR_REPO_URL = `https://github.com/${STAR_REPO}`;
/**
 * Every `gh` call pins the host. `gh` honours `GH_HOST` and a GHES login, so an
 * unpinned `auth status` can report "authenticated" for an enterprise host and an
 * unpinned `api` call would then read (or star) a same-named repository there.
 */
const GH_HOSTNAME = "github.com";

/** Long enough that tab switches never re-spawn `gh`, short enough to notice an external unstar. */
const CACHE_TTL_MS = 10 * 60_000;
const AUTH_TIMEOUT_MS = 5_000;
const API_TIMEOUT_MS = 10_000;

export type StarState = "starred" | "not-starred" | "unauthenticated";

export interface StarStatus {
  state: StarState;
  repo: string;
  url: string;
}

/** Reason codes for a failed star write. Never carries `gh` output — see `starRepository`. */
export type StarErrorCode = "gh_unavailable" | "gh_failed";

export interface StarDeps {
  /** Runs `gh` with the given args; resolves null when `gh` is unavailable. */
  runGh: (args: string[], timeoutMs: number) => Promise<{ status: number | null } | null>;
  nowMs: () => number;
}

/**
 * Async, timeout-bounded `gh` runner. A synchronous spawn here would block Bun's event
 * loop for the whole timeout: a stalled credential helper would freeze proxy traffic,
 * not just this sidebar poll. Output is discarded rather than captured, so `gh`
 * diagnostics (which can name the authenticated account) can never reach a response.
 */
async function spawnGh(args: string[], timeoutMs: number): Promise<{ status: number | null } | null> {
  try {
    // On Windows `gh` is a `.cmd` shim, and a shell-less spawn of the bare name
    // neither consults PATHEXT nor accepts a `.cmd` target. It does not fail
    // fast either — it hangs until the timeout below fires, which is how these
    // sidebar tests turned into 5s timeouts on windows-latest while passing
    // everywhere else. `commandInvocation` is the resolver the CLI already uses.
    const invocation = commandInvocation("gh", args);
    const proc = Bun.spawn([invocation.file, ...invocation.args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
      ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, timeoutMs);
    try {
      return { status: await proc.exited };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // `gh` is not installed / not executable.
    return null;
  }
}

const productionDeps: StarDeps = { runGh: spawnGh, nowMs: () => Date.now() };
let defaultDeps = productionDeps;

let cached: { timestamp: number; state: StarState } | null = null;
/** Coalesces concurrent probes so parallel sidebar polls share one `gh` run. */
let inflight: Promise<StarState> | null = null;
/**
 * Bumped by every authoritative write (a star POST) and by explicit invalidation. A probe
 * that started before the bump is stale on arrival: without this, a read in flight during
 * a successful star would land afterwards and overwrite `starred` with the `not-starred`
 * it observed before the write.
 */
let generation = 0;

/**
 * Probe `gh` for the star state. `GET /user/starred/{repo}` answers 204 when
 * starred and 404 when not, so a non-zero exit is only meaningful once we know
 * the CLI is authenticated — hence the auth check first.
 */
export async function probeStarState(deps: StarDeps = defaultDeps): Promise<StarState> {
  const auth = await deps.runGh(["auth", "status", "--hostname", GH_HOSTNAME], AUTH_TIMEOUT_MS);
  if (!auth || auth.status !== 0) return "unauthenticated";
  const starred = await deps.runGh(
    ["api", "--hostname", GH_HOSTNAME, `/user/starred/${STAR_REPO}`],
    API_TIMEOUT_MS,
  );
  if (!starred) return "unauthenticated";
  return starred.status === 0 ? "starred" : "not-starred";
}

/** Cached star state; `gh` is only spawned when the cache is cold or expired. */
export async function getStarStatus(deps: StarDeps = defaultDeps): Promise<StarStatus> {
  const now = deps.nowMs();
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return { state: cached.state, repo: STAR_REPO, url: STAR_REPO_URL };
  }
  if (!inflight) {
    // Stamp with the time the probe STARTED. Reading the clock on completion would push
    // the TTL forward by the probe's own duration, so a caller that advanced its clock
    // past the TTL could still be served the previous answer.
    const startedAt = now;
    const startedGeneration = generation;
    // The slot is cleared inside the same continuation that commits the cache. Using
    // `.finally()` for that defers it by a microtask, which leaves a window where the
    // next caller awaits an already-settled probe instead of starting a fresh one.
    const probe = probeStarState(deps).then(
      state => {
        if (inflight === probe) inflight = null;
        // A write landed while this read was in flight — its result is authoritative.
        if (startedGeneration !== generation) return cached?.state ?? state;
        cached = { timestamp: startedAt, state };
        return state;
      },
      error => {
        if (inflight === probe) inflight = null;
        throw error;
      },
    );
    inflight = probe;
  }
  const state = await inflight;
  return { state, repo: STAR_REPO, url: STAR_REPO_URL };
}

export function invalidateStarStatusCache(): void {
  generation += 1;
  cached = null;
  inflight = null;
}

/**
 * Route tests must not launch the user's `gh` executable: its installation,
 * authentication helper, and Windows shim are all outside the route contract.
 * Production keeps the real runner; tests install an explicit deterministic
 * dependency and must reset it afterwards.
 */
export function setStarDepsForTests(deps: StarDeps | null): void {
  defaultDeps = deps ?? productionDeps;
  invalidateStarStatusCache();
}

/**
 * Star the repository through the user's `gh` login. Returns the resulting
 * state so the caller does not need a second round trip; an unauthenticated
 * `gh` reports back rather than failing loudly, because the sidebar renders
 * that case as "open GitHub instead".
 *
 * Failures report a fixed reason code. `gh` writes the authenticated account name and
 * request details to stderr, so forwarding that text would leak account data through the
 * management API.
 */
export async function starRepository(
  deps: StarDeps = defaultDeps,
): Promise<{ ok: boolean; status: StarStatus; code?: StarErrorCode }> {
  const auth = await deps.runGh(["auth", "status", "--hostname", GH_HOSTNAME], AUTH_TIMEOUT_MS);
  if (!auth || auth.status !== 0) {
    generation += 1;
    cached = { timestamp: deps.nowMs(), state: "unauthenticated" };
    return {
      ok: false,
      status: { state: "unauthenticated", repo: STAR_REPO, url: STAR_REPO_URL },
      code: "gh_unavailable",
    };
  }
  const result = await deps.runGh(
    ["api", "--hostname", GH_HOSTNAME, "-X", "PUT", `/user/starred/${STAR_REPO}`],
    API_TIMEOUT_MS,
  );
  if (!result || result.status !== 0) {
    invalidateStarStatusCache();
    return {
      ok: false,
      status: { state: "not-starred", repo: STAR_REPO, url: STAR_REPO_URL },
      code: result ? "gh_failed" : "gh_unavailable",
    };
  }
  // Authoritative: this call just starred the repo. Bumping the generation makes any
  // read that is still in flight discard its now-obsolete observation.
  generation += 1;
  cached = { timestamp: deps.nowMs(), state: "starred" };
  return { ok: true, status: { state: "starred", repo: STAR_REPO, url: STAR_REPO_URL } };
}
