import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildChatgptShimLauncher } from "../../src/chatgpt/desktop-unblock/runtime";
import { rewriteAppServerLine } from "../../src/chatgpt/desktop-unblock/app-server-rewrite";
import { createRpcLineFilter, runStdoutFilter } from "../../src/chatgpt/desktop-unblock/app-server-shim";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * The desktop app reads the composer's send gate from the bundled app-server over JSON-RPC, not
 * from Chromium (#6196). The shim sits on that one stdio pipe and opens the plain-quota gate.
 */

const rpcResult = (result: unknown) => JSON.stringify({ id: 2, result });

const EXHAUSTED_RATE_LIMITS = {
  ordinaryUsageAllowed: false,
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1790000000 },
    planType: "pro",
    rateLimitReachedType: "rate_limit_reached",
  },
  rateLimitsByLimitId: { codex: { limitId: "codex", rateLimitReachedType: "rate_limit_reached" } },
};

describe("app-server line rewrite", () => {
  test("a plain-quota reached type is cleared and ordinary usage is allowed again", () => {
    const out = JSON.parse(rewriteAppServerLine(rpcResult(EXHAUSTED_RATE_LIMITS))!);
    expect(out.result.ordinaryUsageAllowed).toBe(true);
    expect(out.result.rateLimits.rateLimitReachedType).toBeNull();
    expect(out.result.rateLimitsByLimitId.codex.rateLimitReachedType).toBeNull();
    // Displayed usage is never changed.
    expect(out.result.rateLimits.primary).toEqual(EXHAUSTED_RATE_LIMITS.rateLimits.primary);
    expect(out.result.rateLimits.planType).toBe("pro");
  });

  test("a workspace or credit reached type is left as the server sent it", () => {
    for (const type of ["workspace_owner_usage_limit_reached", "workspace_member_credits_depleted"]) {
      const line = rpcResult({ ...EXHAUSTED_RATE_LIMITS, rateLimits: { ...EXHAUSTED_RATE_LIMITS.rateLimits, rateLimitReachedType: type }, rateLimitsByLimitId: {} });
      expect(rewriteAppServerLine(line)).toBeNull();
    }
  });

  test("a plain quota next to a workspace block keeps ordinary usage closed", () => {
    const line = rpcResult({
      ordinaryUsageAllowed: false,
      rateLimits: { rateLimitReachedType: "rate_limit_reached" },
      rateLimitsByLimitId: { other: { rateLimitReachedType: "workspace_owner_credits_depleted" } },
    });
    const out = JSON.parse(rewriteAppServerLine(line)!);
    expect(out.result.rateLimits.rateLimitReachedType).toBeNull();
    expect(out.result.rateLimitsByLimitId.other.rateLimitReachedType).toBe("workspace_owner_credits_depleted");
    expect(out.result.ordinaryUsageAllowed).toBe(false);
  });

  test("a Plus account with only the 5-hour window exhausted is opened and both windows are kept (#6196)", () => {
    // The reported state: 5-hour window at 100 %, weekly window at 32 %, Send disabled.
    const line = rpcResult({
      ordinaryUsageAllowed: false,
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1790000000 },
        secondary: { usedPercent: 32, windowDurationMins: 10080, resetsAt: 1790500000 },
        planType: "plus",
        rateLimitReachedType: "rate_limit_reached",
      },
    });
    const out = JSON.parse(rewriteAppServerLine(line)!);
    expect(out.result.ordinaryUsageAllowed).toBe(true);
    expect(out.result.rateLimits.rateLimitReachedType).toBeNull();
    expect(out.result.rateLimits.primary).toEqual({ usedPercent: 100, windowDurationMins: 300, resetsAt: 1790000000 });
    expect(out.result.rateLimits.secondary).toEqual({ usedPercent: 32, windowDurationMins: 10080, resetsAt: 1790500000 });
  });

  test("a quota window at 100% opens ordinary usage even when no reached type is sent", () => {
    const line = rpcResult({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100, windowDurationMins: 10080 }, rateLimitReachedType: null } });
    const out = JSON.parse(rewriteAppServerLine(line)!);
    expect(out.result.ordinaryUsageAllowed).toBe(true);
    expect(out.result.rateLimits.primary.usedPercent).toBe(100);
  });

  test("ordinary usage stays closed without quota evidence, or when spend control also blocks", () => {
    // Closed for a reason the payload does not show: not ours to argue with.
    expect(rewriteAppServerLine(rpcResult({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 12 } } }))).toBeNull();
    // Quota is exhausted but a spend control also stands.
    expect(rewriteAppServerLine(rpcResult({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100 }, spendControlReached: { used: 5, limit: 5 } } }))).toBeNull();
  });

  test("notifications carrying the same fields are rewritten too", () => {
    const line = JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: { rateLimitReachedType: "rate_limit_reached" } } });
    expect(JSON.parse(rewriteAppServerLine(line)!).params.rateLimits.rateLimitReachedType).toBeNull();
  });

  test("only rate-limit messages are rewritten; tool results and other results that nest gate fields are left alone", () => {
    const toolResult = JSON.stringify({
      method: "item/completed",
      params: { item: { type: "commandExecution", output: { rate_limit: { allowed: false, limit_reached: true }, rateLimitReachedType: "rate_limit_reached" } } },
    });
    expect(rewriteAppServerLine(toolResult)).toBeNull();

    const otherResult = JSON.stringify({ id: 9, result: { data: { rate_limit: { allowed: false }, rateLimits: { rateLimitReachedType: "rate_limit_reached" } } } });
    expect(rewriteAppServerLine(otherResult)).toBeNull();

    const blocks = JSON.stringify({ id: 10, result: { blockedFeatures: [{ name: "send", blockReason: "usage_limit" }] } });
    expect(rewriteAppServerLine(blocks)).toBeNull();
  });

  test("lines without gate fields, unparseable lines and already-open gates are not touched", () => {
    expect(rewriteAppServerLine(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "hello" } }))).toBeNull();
    expect(rewriteAppServerLine('{"rateLimits": broken')).toBeNull();
    expect(rewriteAppServerLine(rpcResult({ ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null } }))).toBeNull();
  });

  test("a message that only quotes a field name inside text is not modified", () => {
    const line = JSON.stringify({ method: "item/completed", params: { text: "the rateLimitReachedType field is rate_limit_reached" } });
    expect(rewriteAppServerLine(line)).toBeNull();
  });
});

describe("app-server line filter", () => {
  const collect = (chunks: Uint8Array[], filter = createRpcLineFilter()) => {
    const parts: Uint8Array[] = [];
    for (const chunk of chunks) parts.push(...filter.push(chunk));
    parts.push(...filter.flush());
    return new TextDecoder().decode(Buffer.concat(parts));
  };
  const enc = (s: string) => new TextEncoder().encode(s);

  test("untouched lines come back byte for byte, including multibyte text and odd line endings", () => {
    const text = `${JSON.stringify({ method: "x", params: { t: "你好 🌏 é" } })}\n\r\n${JSON.stringify({ a: 1 })}\r\n`;
    expect(collect([enc(text)])).toBe(text);
  });

  test("a gate line is rewritten wherever the chunk boundaries fall", () => {
    const gate = rpcResult(EXHAUSTED_RATE_LIMITS);
    const stream = `${JSON.stringify({ method: "a", params: { t: "你好" } })}\n${gate}\n${JSON.stringify({ method: "b" })}\n`;
    const bytes = enc(stream);
    for (const size of [1, 2, 3, 7, 64, bytes.length]) {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
      const out = collect(chunks).split("\n");
      expect(out[0]).toBe(JSON.stringify({ method: "a", params: { t: "你好" } }));
      expect(JSON.parse(out[1]!).result.rateLimits.rateLimitReachedType).toBeNull();
      expect(out[2]).toBe(JSON.stringify({ method: "b" }));
      expect(out[3]).toBe("");
    }
  });

  test("a final line without a newline is flushed, and rewritten when it needs it", () => {
    expect(collect([enc('{"method":"tail"}')])).toBe('{"method":"tail"}');
    const out = collect([enc(rpcResult(EXHAUSTED_RATE_LIMITS))]);
    expect(out.endsWith("\n")).toBe(false);
    expect(JSON.parse(out).result.ordinaryUsageAllowed).toBe(true);
  });
});

describe("app-server stdout filter", () => {
  const chunksOf = async function* (parts: string[]) {
    for (const part of parts) yield new TextEncoder().encode(part);
  };
  const run = async (parts: string[], rewrite?: (line: string) => string | null) => {
    const written: Uint8Array[] = [];
    await runStdoutFilter(chunksOf(parts), bytes => void written.push(bytes), rewrite);
    return new TextDecoder().decode(Buffer.concat(written));
  };

  test("copies the server's stdout through, rewriting only the gate lines", async () => {
    const out = await run([`${JSON.stringify({ method: "a" })}\n${rpcResult(EXHAUSTED_RATE_LIMITS)}\n`, '{"method":"done"}']);
    const lines = out.split("\n");
    expect(lines[0]).toBe('{"method":"a"}');
    expect(JSON.parse(lines[1]!).result.rateLimits.rateLimitReachedType).toBeNull();
    expect(lines[2]).toBe('{"method":"done"}');
  });

  test("a rewrite that throws passes its line through unchanged instead of breaking the stream", async () => {
    const text = `${rpcResult(EXHAUSTED_RATE_LIMITS)}\n{"method":"after"}\n`;
    const out = await run([text], () => {
      throw new Error("boom");
    });
    expect(out).toBe(text);
  });
});

describe("app-server launcher", () => {
  const entry = repoPath("src/chatgpt/desktop-unblock/app-server-shim.ts");
  const scriptIn = (dir: string, name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    chmodSync(path, 0o755);
    return path;
  };

  test("fails open: with the filter's runtime gone it executes the real binary directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-launcher-"));
    try {
      const real = scriptIn(dir, "real.sh", '#!/bin/bash\necho "REAL:$*"\n');
      const launcher = scriptIn(dir, "launcher.sh", buildChatgptShimLauncher("/nonexistent/bun", "/nonexistent/shim.ts", real));
      const out = spawnSync(launcher, ["app-server", "--flag"], { encoding: "utf8" });
      expect(out.stdout.trim()).toBe("REAL:app-server --flag");
      expect(out.status).toBe(0);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("fails open: a filter that does not load leaves the real binary's stdout untouched", () => {
    // Otherwise the app-server would write its JSON-RPC answers into a dead pipe.
    const dir = mkdtempSync(join(tmpdir(), "ocx-launcher-broken-"));
    try {
      const real = scriptIn(dir, "real.sh", `#!/bin/bash\necho '${rpcResult(EXHAUSTED_RATE_LIMITS)}'\n`);
      const broken = scriptIn(dir, "broken-shim.ts", 'throw new Error("the filter does not load");\n');
      const launcher = scriptIn(dir, "launcher.sh", buildChatgptShimLauncher(process.execPath, broken, real));
      const out = spawnSync(launcher, ["app-server"], { encoding: "utf8" });
      expect(out.status).toBe(0);
      expect(out.stdout.trim()).toBe(rpcResult(EXHAUSTED_RATE_LIMITS));
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("the real binary replaces the launcher: same pid, stdin and stderr untouched, exit code kept", () => {
    // The app checks the code-signing identity of the process on its app-tools pipe, so the server
    // must stay the process the app started rather than a child of a wrapper.
    const dir = mkdtempSync(join(tmpdir(), "ocx-launcher-exec-"));
    try {
      const gate = rpcResult(EXHAUSTED_RATE_LIMITS).replace(/'/g, "'\\''");
      const real = scriptIn(
        dir,
        "real with space.sh",
        `#!/bin/bash\necho "PID:$$ ARGS:$*"\nread -r line\necho "STDIN:$line"\necho '${gate}'\necho "to-stderr" >&2\nexit 7\n`,
      );
      const launcher = scriptIn(dir, "launcher.sh", buildChatgptShimLauncher(process.execPath, entry, real));
      const out = spawnSync(launcher, ["app-server", "--analytics-default-enabled"], { encoding: "utf8", input: "hello from the app\n" });
      const lines = out.stdout.trim().split("\n");
      expect(lines[0]).toBe(`PID:${out.pid} ARGS:app-server --analytics-default-enabled`);
      expect(lines[1]).toBe("STDIN:hello from the app");
      expect(JSON.parse(lines[2]!).result.rateLimits.rateLimitReachedType).toBeNull();
      expect(out.stderr).toBe("to-stderr\n");
      expect(out.status).toBe(7);
    } finally {
      removeTreeWithRetry(dir);
    }
  });
});
