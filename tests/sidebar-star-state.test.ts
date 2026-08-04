import { afterEach, describe, expect, test } from "bun:test";
import {
  getStarStatus,
  invalidateStarStatusCache,
  probeStarState,
  starRepository,
  STAR_REPO,
  type StarDeps,
} from "../src/github/star-state";

type GhCall = { args: string[]; timeoutMs: number };

const GH_HOSTNAME = "github.com";

/**
 * Fake `gh` runner. `script` maps a command shape to its result so a test can say
 * "auth is fine but the star read 404s" without spawning a process.
 */
function ghDeps(
  script: (args: string[]) => { status: number | null } | null,
  clock: { now: number } = { now: 1_000 },
): StarDeps & { calls: GhCall[] } {
  const calls: GhCall[] = [];
  return {
    calls,
    async runGh(args, timeoutMs) {
      calls.push({ args, timeoutMs });
      const result = script(args);
      if (!result) return null;
      return { status: result.status };
    },
    nowMs: () => clock.now,
  };
}

const isAuthCall = (args: string[]) => args[0] === "auth";

afterEach(() => {
  invalidateStarStatusCache();
});

describe("probeStarState", () => {
  test("reports unauthenticated and never asks about the star when gh is logged out", async () => {
    const deps = ghDeps(args => (isAuthCall(args) ? { status: 1 } : { status: 0 }));
    expect(await probeStarState(deps)).toBe("unauthenticated");
    // A star read on a logged-out CLI would 401 and be indistinguishable from "not starred".
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].args).toEqual(["auth", "status", "--hostname", GH_HOSTNAME]);
  });

  test("reports unauthenticated when gh is not installed at all", async () => {
    const deps = ghDeps(() => null);
    expect(await probeStarState(deps)).toBe("unauthenticated");
  });

  test("maps a 204 star read to starred and a non-zero exit to not-starred", async () => {
    const starred = ghDeps(args => ({ status: isAuthCall(args) ? 0 : 0 }));
    expect(await probeStarState(starred)).toBe("starred");
    expect(starred.calls[1].args).toEqual(["api", "--hostname", GH_HOSTNAME, `/user/starred/${STAR_REPO}`]);

    const notStarred = ghDeps(args => ({ status: isAuthCall(args) ? 0 : 1 }));
    expect(await probeStarState(notStarred)).toBe("not-starred");
  });

  test("pins every gh call to github.com so a GHES login cannot answer for us", async () => {
    // `gh` honours GH_HOST and enterprise logins; an unpinned call could read or star a
    // same-named repository on the wrong host.
    const deps = ghDeps(() => ({ status: 0 }));
    await probeStarState(deps);
    for (const call of deps.calls) {
      expect(call.args).toContain("--hostname");
      expect(call.args[call.args.indexOf("--hostname") + 1]).toBe(GH_HOSTNAME);
    }
  });
});

describe("getStarStatus caching", () => {
  test("serves a second read from cache instead of spawning gh again", async () => {
    const deps = ghDeps(() => ({ status: 0 }));
    expect((await getStarStatus(deps)).state).toBe("starred");
    const afterFirst = deps.calls.length;
    expect((await getStarStatus(deps)).state).toBe("starred");
    expect(deps.calls).toHaveLength(afterFirst);
  });

  test("coalesces concurrent cold reads into one gh probe", async () => {
    const deps = ghDeps(() => ({ status: 0 }));
    const [a, b, c] = await Promise.all([getStarStatus(deps), getStarStatus(deps), getStarStatus(deps)]);
    expect([a.state, b.state, c.state]).toEqual(["starred", "starred", "starred"]);
    // auth + api, once — not three times.
    expect(deps.calls).toHaveLength(2);
  });

  test("re-probes once the TTL has elapsed", async () => {
    const clock = { now: 1_000 };
    const deps = ghDeps(args => ({ status: isAuthCall(args) ? 0 : 1 }), clock);
    expect((await getStarStatus(deps)).state).toBe("not-starred");
    const afterFirst = deps.calls.length;
    clock.now += 11 * 60_000;
    expect((await getStarStatus(deps)).state).toBe("not-starred");
    expect(deps.calls.length).toBeGreaterThan(afterFirst);
  });

  test("exposes the repo slug and URL the sidebar links to", async () => {
    const deps = ghDeps(() => ({ status: 0 }));
    const status = await getStarStatus(deps);
    expect(status.repo).toBe(STAR_REPO);
    expect(status.url).toBe(`https://github.com/${STAR_REPO}`);
  });
});

describe("starRepository", () => {
  test("a read in flight during a successful star cannot overwrite the starred result", async () => {
    // Regression: the probe committed its snapshot unconditionally, so a GET that started
    // before the POST landed afterwards and wrote back the pre-star "not-starred".
    let releaseRead: (() => void) | null = null;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    let sawStarWrite = false;
    const calls: string[][] = [];
    const deps: StarDeps = {
      async runGh(args) {
        calls.push(args);
        if (args.includes("PUT")) { sawStarWrite = true; return { status: 0 }; }
        if (args[0] === "auth") return { status: 0 };
        // The star READ blocks until the test releases it, and reports the pre-star truth.
        if (!sawStarWrite) await readGate;
        return { status: 1 };
      },
      nowMs: () => 1_000,
    };

    const pendingRead = getStarStatus(deps);
    const write = await starRepository(deps);
    expect(write.ok).toBe(true);

    releaseRead?.();
    await pendingRead;

    expect((await getStarStatus(deps)).state).toBe("starred");
  });

  test("PUTs the star and caches the result so the next read needs no probe", async () => {
    const deps = ghDeps(() => ({ status: 0 }));
    const result = await starRepository(deps);
    expect(result.ok).toBe(true);
    expect(result.status.state).toBe("starred");
    expect(deps.calls.at(-1)?.args).toEqual([
      "api", "--hostname", GH_HOSTNAME, "-X", "PUT", `/user/starred/${STAR_REPO}`,
    ]);

    const callsAfterWrite = deps.calls.length;
    expect((await getStarStatus(deps)).state).toBe("starred");
    expect(deps.calls).toHaveLength(callsAfterWrite);
  });

  test("reports unauthenticated without attempting the write", async () => {
    const deps = ghDeps(args => (isAuthCall(args) ? { status: 1 } : { status: 0 }));
    const result = await starRepository(deps);
    expect(result.ok).toBe(false);
    expect(result.status.state).toBe("unauthenticated");
    expect(result.code).toBe("gh_unavailable");
    expect(deps.calls).toHaveLength(1);
  });

  test("reports a fixed code on failure and never forwards gh output", async () => {
    const deps = ghDeps(args => (isAuthCall(args) ? { status: 0 } : { status: 1 }));
    const result = await starRepository(deps);
    expect(result.ok).toBe(false);
    expect(result.status.state).toBe("not-starred");
    expect(result.code).toBe("gh_failed");
    // `gh` stderr names the authenticated account; the result must carry no free text.
    expect(Object.keys(result)).not.toContain("error");

    const callsAfterWrite = deps.calls.length;
    await getStarStatus(deps);
    expect(deps.calls.length).toBeGreaterThan(callsAfterWrite);
  });
});
