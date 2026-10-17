import { afterEach, describe, expect, test } from "bun:test";
import {
  formatLowQuotaNotice,
  lowQuotaNotifierArgv,
  resolveLowQuotaDesktopSink,
  type LowQuotaNotice,
  type LowQuotaNotifierIo,
} from "../../src/codex/low-quota-desktop-notifier";

const NOTICE: LowQuotaNotice = { accountLabel: "pabc123", window: "weekly", percentUsed: 85, threshold: 80, resetAt: 1_800_000_000_000 };
const always = () => true;

type FakeChild = { argv: string[]; killed: number; exit(code: number | null): void; fail(error: Error): void };

function fakeSpawn(): { io: Pick<LowQuotaNotifierIo, "spawn">; children: FakeChild[] } {
  const children: FakeChild[] = [];
  return {
    children,
    io: {
      spawn(argv) {
        let resolveExit!: (code: number | null) => void;
        let rejectExit!: (error: Error) => void;
        const exited = new Promise<number | null>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
        const child: FakeChild = { argv, killed: 0, exit: code => resolveExit(code), fail: error => rejectExit(error) };
        children.push(child);
        return { exited, kill: () => { child.killed++; } };
      },
    },
  };
}

const previousGuard = process.env.OCX_TEST_HOME_GUARD;
afterEach(() => {
  if (previousGuard === undefined) delete process.env.OCX_TEST_HOME_GUARD;
  else process.env.OCX_TEST_HOME_GUARD = previousGuard;
});

describe("low-quota desktop notifier", () => {
  test("formats a pseudonymous, bounded message with reset context", () => {
    expect(formatLowQuotaNotice(NOTICE, () => "Mon 10:00")).toEqual({
      title: "OpenCodex quota",
      body: "Account pabc123: weekly quota at 85% (threshold 80%), resets Mon 10:00.",
    });
    expect(formatLowQuotaNotice({ ...NOTICE, window: "short", resetAt: null }).body)
      .toBe("Account pabc123: 5-hour quota at 85% (threshold 80%), reset time unknown.");
  });

  test("macOS passes notice text as osascript argv, never as script source", () => {
    const hostile = 'x" & do shell script "touch /tmp/pwned" & "';
    const argv = lowQuotaNotifierArgv("darwin", always, "OpenCodex quota", hostile)!;
    expect(argv).toEqual([
      "/usr/bin/osascript", "-e", "on run argv", "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run",
      "OpenCodex quota", hostile,
    ]);
    expect(argv.slice(0, 7).some(part => part.includes("pwned"))).toBe(false);
  });

  test("Linux uses a literal notify-send path, stops option parsing and escapes markup", () => {
    const seen: string[] = [];
    const exists = (path: string) => { seen.push(path); return path === "/usr/local/bin/notify-send"; };
    expect(lowQuotaNotifierArgv("linux", exists, "--title", "<b>a</b> & --urgency=critical")).toEqual([
      "/usr/local/bin/notify-send", "--app-name=OpenCodex", "--", "--title", "&lt;b&gt;a&lt;/b&gt; &amp; --urgency=critical",
    ]);
    expect(seen.every(path => path.startsWith("/"))).toBe(true);
    expect(lowQuotaNotifierArgv("linux", () => false, "t", "b")).toBeUndefined();
  });

  test("unsupported platforms and missing notifiers resolve no sink", () => {
    const { io } = fakeSpawn();
    expect(resolveLowQuotaDesktopSink({ ...io, platform: "win32", exists: always })).toBeUndefined();
    expect(resolveLowQuotaDesktopSink({ ...io, platform: "linux", exists: () => false })).toBeUndefined();
    expect(resolveLowQuotaDesktopSink({ ...io, platform: "darwin", exists: () => false })).toBeUndefined();
  });

  test("an armed test process never reaches a real notifier without an injected spawn", () => {
    process.env.OCX_TEST_HOME_GUARD = "1";
    expect(resolveLowQuotaDesktopSink({ platform: "darwin", exists: always })).toBeUndefined();
    const { io } = fakeSpawn();
    expect(resolveLowQuotaDesktopSink({ ...io, platform: "darwin", exists: always })).toBeDefined();
  });

  test("resolves on exit 0 and rejects on non-zero exit or spawn error", async () => {
    const { io, children } = fakeSpawn();
    const sink = resolveLowQuotaDesktopSink({ ...io, platform: "darwin", exists: always })!;
    const ok = sink(NOTICE, new AbortController().signal);
    children[0]!.exit(0);
    await expect(ok).resolves.toBeUndefined();
    expect(children[0]!.argv.at(-1)).toContain("Account pabc123");

    const bad = sink(NOTICE, new AbortController().signal);
    children[1]!.exit(1);
    await expect(bad).rejects.toThrow("exited 1");

    const broken = sink(NOTICE, new AbortController().signal);
    children[2]!.fail(new Error("ENOENT"));
    await expect(broken).rejects.toThrow("ENOENT");

    const throwing = resolveLowQuotaDesktopSink({ platform: "darwin", exists: always, spawn: () => { throw new Error("spawn failed"); } })!;
    await expect(throwing(NOTICE, new AbortController().signal)).rejects.toThrow("spawn failed");
  });

  test("times out by killing the child and clearing its listener", async () => {
    const { io, children } = fakeSpawn();
    const sink = resolveLowQuotaDesktopSink({ ...io, platform: "darwin", exists: always, timeoutMs: 5 })!;
    const controller = new AbortController();
    const removed: string[] = [];
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
      removed.push(type);
      remove(type, listener);
    }) as typeof controller.signal.removeEventListener;
    await expect(sink(NOTICE, controller.signal)).rejects.toThrow("timed out");
    expect(children[0]!.killed).toBe(1);
    expect(removed).toEqual(["abort"]);
    controller.abort();
    expect(children[0]!.killed).toBe(1);
    children[0]!.exit(0);
  });

  test("abort kills an in-flight child once and a pre-aborted signal never spawns", async () => {
    const { io, children } = fakeSpawn();
    const sink = resolveLowQuotaDesktopSink({ ...io, platform: "darwin", exists: always, timeoutMs: 60_000 })!;
    const controller = new AbortController();
    const pending = sink(NOTICE, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(children[0]!.killed).toBe(1);
    children[0]!.exit(0);
    await Promise.resolve();
    expect(children[0]!.killed).toBe(1);

    const aborted = new AbortController();
    aborted.abort();
    await expect(sink(NOTICE, aborted.signal)).rejects.toThrow("cancelled");
    expect(children).toHaveLength(1);
  });
});

describe("low-quota desktop notifier cleanup", () => {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  for (const outcome of ["exit 0", "exit 1", "spawn error", "abort"] as const) {
    test("after " + outcome + " no timer or abort listener can kill the child again", async () => {
      const { io, children } = fakeSpawn();
      const sink = resolveLowQuotaDesktopSink({ ...io, platform: "darwin", exists: always, timeoutMs: 10 })!;
      const controller = new AbortController();
      const pending = sink(NOTICE, controller.signal).then(() => "resolved", () => "rejected");
      const child = children[0]!;
      if (outcome === "exit 0") child.exit(0);
      else if (outcome === "exit 1") child.exit(1);
      else if (outcome === "spawn error") child.fail(new Error("EPIPE"));
      else controller.abort();
      expect(await pending).toBe(outcome === "exit 0" ? "resolved" : "rejected");
      const killsAtSettle = child.killed;
      expect(killsAtSettle).toBe(outcome === "abort" ? 1 : 0);
      controller.abort();
      await sleep(25);
      expect(child.killed).toBe(killsAtSettle);
    });
  }
});
