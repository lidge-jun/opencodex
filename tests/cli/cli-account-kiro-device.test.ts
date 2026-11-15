import { describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import { formatKiroDeviceInstructions, handleAccountAuthCommand } from "../../src/cli/account-auth";

interface Sent { path: string; body?: Record<string, unknown> }

/**
 * Hostile provider text for the native Kiro device handoff.
 *
 * `\u061c` (Arabic letter mark), `\u2028` (line separator), `\u206a`-`\u206f` (deprecated bidi
 * controls) and `\u202e` (right-to-left override) are all invisible or line-driving, and the
 * narrower strip regex the CLI used before this covered none of them. `\u{e0041}` is a tag-plane
 * character, which lives outside the BMP and needs a code-point-aware match to escape.
 */
const HOSTILE_URI = "https://example.test/verify?code=1\u202e\u061c";
const HOSTILE_CODE = "A\u061cB\u2028C\u206aD\u206fE";
const HOSTILE_FLOW = "flow\u206b-1\u{e0041}";

const UNSAFE_CODES = [0x202e, 0x061c, 0x2028, 0x206a, 0x206b, 0x206f, 0xe0041] as const;

const kiroReply = (overrides: Record<string, unknown> = {}) => ({
  flowId: "flow-1", method: "google", state: "pending", userCode: "ABCD",
  verificationUri: "https://example.test/verify", ...overrides,
});

/**
 * Run a command with both terminal surfaces captured: `console.log` for the JSON/human branches
 * that use it, and fd 1 for the instruction block, which writes synchronously (#1007) and never
 * passes through `console.log`. The fd-1 spy has to report the bytes it consumed or the writer's
 * partial-write loop spins.
 */
async function run(command: "login" | "cancel", args: string[], reply: Record<string, unknown> = kiroReply()) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const written: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => { logs.push(parts.join(" ")); };
  console.error = (...parts) => { errors.push(parts.join(" ")); };
  const writeSpy = spyOn(nodeFs, "writeSync").mockImplementation(((fd: number, data: unknown, offset?: number, length?: number) => {
    if (fd !== 1) return 0;
    if (Buffer.isBuffer(data)) {
      const start = offset ?? 0;
      const size = length ?? data.length - start;
      written.push(data.subarray(start, start + size).toString("utf8"));
      return size;
    }
    const text = String(data);
    written.push(text);
    return Buffer.byteLength(text, "utf8");
  }) as never);
  try {
    const code = await handleAccountAuthCommand(command, args, {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        sent.push({ path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
        return new Response(JSON.stringify(reply), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    return { code, sent, logs: logs.join("\n"), errors: errors.join("\n"), written: written.join("") };
  } finally {
    writeSpy.mockRestore();
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("Kiro CLI native device login", () => {
  // The C0/C1 half of the contract, unchanged in intent from #6001 but now escaping instead of
  // deleting: the same characters reach fd 1, spelled so they cannot act on the terminal.
  test("human-readable instructions contain no terminal control bytes", () => {
    const block = formatKiroDeviceInstructions({
      verificationUriComplete: "https://example.test/verify\u001b]0;owned\u0007",
      userCode: "ABCD\u001b[31m", flowId: "flow\u009b1m",
    });
    expect(block).toContain("User code: ABCD\\x1b[31m");
    expect(block).toContain("https://example.test/verify\\x1b]0;owned\\x07");
    expect(block).toContain("Flow: flow\\u009b1m");
    expect(block).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });

  // The formatter used to strip with a narrower local regex than the shared sanitizer, so the
  // invisible-formatting block that `terminalSafeText` already covers reached fd 1 unchanged.
  test("invisible formatting the local strip missed is escaped, not dropped", () => {
    const block = formatKiroDeviceInstructions({
      verificationUriComplete: HOSTILE_URI, userCode: HOSTILE_CODE, flowId: HOSTILE_FLOW,
    });
    expect(block).toBe([
      "https://example.test/verify?code=1\\u202e\\u061c",
      "User code: A\\u061cB\\u2028C\\u206aD\\u206fE",
      "Flow: flow\\u206b-1\\u{e0041}",
    ].join("\n"));
    for (const code of UNSAFE_CODES) expect(block).not.toContain(String.fromCodePoint(code));
  });

  // Layout is the formatter's own: one line per field. Escaping must not fold those breaks away,
  // and it must not turn a legitimate multi-line provider value into extra printed lines.
  test("the formatter keeps its own line breaks and escapes ones inside a field", () => {
    const block = formatKiroDeviceInstructions({
      verificationUri: "https://example.test/verify", userCode: "AB\nCD", flowId: "flow-1",
    });
    expect(block.split("\n")).toEqual(["https://example.test/verify", "User code: AB\\x0aCD", "Flow: flow-1"]);
  });

  test("legitimate multilingual text and emoji survive the formatter", () => {
    const block = formatKiroDeviceInstructions({
      verificationUriComplete: "https://example.test/verify",
      userCode: "코드-\u0645\u0631\u062d\u0628\u0627-\ud83d\ude80-\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67",
    });
    expect(block).toContain("User code: 코드-\u0645\u0631\u062d\u0628\u0627-\ud83d\ude80-\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67");
  });

  test("--method writes the escaped block to fd 1 and keeps the raw handoff in JSON", async () => {
    const reply = kiroReply({
      flowId: HOSTILE_FLOW, userCode: HOSTILE_CODE, verificationUriComplete: HOSTILE_URI,
    });
    const human = await run("login", ["kiro", "--method", "google", "--no-wait"], reply);
    expect(human.code).toBe(0);
    expect(human.written).toBe([
      "https://example.test/verify?code=1\\u202e\\u061c",
      "User code: A\\u061cB\\u2028C\\u206aD\\u206fE",
      "Flow: flow\\u206b-1\\u{e0041}",
      "",
    ].join("\n"));
    for (const code of UNSAFE_CODES) expect(human.written).not.toContain(String.fromCodePoint(code));

    // The machine-readable branch is not a terminal: it must still carry the provider's exact
    // bytes, because a consumer keyed on the user code cannot use an escaped one.
    const json = await run("login", ["kiro", "--method", "google", "--no-wait", "--json"], reply);
    expect(json.code).toBe(0);
    expect(json.written).toBe("");
    expect(JSON.parse(json.logs)).toMatchObject({
      flowId: HOSTILE_FLOW, userCode: HOSTILE_CODE, verificationUriComplete: HOSTILE_URI,
    });
  });

  test("--method starts native flow and prints only the public view", async () => {
    const result = await run("login", ["kiro", "--method", "google", "--no-wait", "--json"]);
    expect(result.code).toBe(0);
    expect(result.sent).toEqual([{ path: "/api/oauth/login", body: { provider: "kiro", method: "google" } }]);
    expect(result.logs).toContain("flow-1");
    expect(result.logs).not.toMatch(/private-|clientSecret|refreshToken|deviceCode/);
  });
  test("--method with --reauth is a usage error without a request", async () => {
    const result = await run("login", ["kiro", "--method", "google", "--reauth"]);
    expect(result.code).toBe(2);
    expect(result.sent).toHaveLength(0);
  });
  test("cancel by flow targets native Kiro flow", async () => {
    const result = await run("cancel", ["kiro", "--flow", "flow-1", "--json"]);
    expect(result.code).toBe(0);
    expect(result.sent).toEqual([{ path: "/api/oauth/login/cancel", body: { provider: "kiro", flowId: "flow-1" } }]);
  });
});
