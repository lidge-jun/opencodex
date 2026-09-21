/**
 * The native Chat route forwards the caller's messages to the upstream without translating
 * them, which also meant it never read `foldDeveloperRoleToSystem`. An operator who had
 * recorded that a destination rejects the `developer` role still sent `developer` there, and
 * the destination answered `400 role 'developer' is not allowed` before the model saw the
 * request — a failure that lives outside this repository, which is why nothing here caught it.
 *
 * These cases drive the real `/v1/chat/completions` endpoint and read the body the upstream
 * actually received, because the defect was in which body the route builds, not in what the
 * adapter returns when it is called directly. The translated route's own role decision is
 * covered beside that adapter in `tests/adapters/openai/openai-chat-developer-position.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-chat-developer-role-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-chat-developer-role-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

/** A mid-conversation instruction, with a sibling field and turns on both sides of it. */
const CONVERSATION = [
  { role: "system", content: "base instructions" },
  { role: "user", content: "First turn." },
  { role: "developer", name: "reminder-sentinel", content: "Answer in exactly one sentence." },
  { role: "user", content: "Second turn." },
];

/** The instruction's index in the conversation above; it must hold whatever role it carries. */
const INSTRUCTION_SLOT = CONVERSATION.findIndex(message => message.role === "developer");

/** Send one non-streaming request through the proxy and return the body the upstream received. */
async function upstreamBodyFor(
  providerOverrides: Partial<OcxProviderConfig>,
): Promise<Record<string, unknown>> {
  const captured: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      captured.push({ pathname, body: await req.json() as Record<string, unknown> });
      // The translated route reaches a different endpoint, so answering every path would let a
      // rerouted request look like a successful native send.
      if (!pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `unexpected path ${pathname}` } }, { status: 404 });
      }
      return Response.json({
        id: "chatcmpl_developer_role",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
        apiKey: "k",
        allowPrivateNetwork: true,
        ...providerOverrides,
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", stream: false, messages: CONVERSATION }),
    });
    expect(response.status).toBe(200);
    await response.text();
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
  expect(captured).toHaveLength(1);
  expect(captured[0]!.pathname).toBe("/v1/chat/completions");
  return captured[0]!.body;
}

function upstreamMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.messages as Array<Record<string, unknown>>;
}

describe("the developer role on the native Chat wire", () => {
  test("an unrecorded destination still receives the caller's messages verbatim", async () => {
    // The default is the one thing this change must not move: nobody has recorded what this
    // destination accepts, so the route has no reason to rewrite what the caller sent.
    expect(upstreamMessages(await upstreamBodyFor({}))).toEqual(CONVERSATION);
  });

  test("a destination recorded as rejecting the role receives system in the same slot", async () => {
    const messages = upstreamMessages(await upstreamBodyFor({ foldDeveloperRoleToSystem: true }));

    expect(messages.map(message => message.role)).toEqual(["system", "user", "system", "user"]);
    // The role changes and nothing else does: the sibling field survives, and so does the text.
    expect(messages[INSTRUCTION_SLOT]).toEqual({
      ...CONVERSATION[INSTRUCTION_SLOT]!,
      role: "system",
    });
    // The turns this instruction was written to sit between are still on either side of it.
    expect(messages.filter((_, index) => index !== INSTRUCTION_SLOT))
      .toEqual(CONVERSATION.filter((_, index) => index !== INSTRUCTION_SLOT));
  });

  test("a destination recorded as accepting the role receives it unchanged", async () => {
    const messages = upstreamMessages(await upstreamBodyFor({ foldDeveloperRoleToSystem: false }));

    expect(messages).toEqual(CONVERSATION);
    expect(messages[INSTRUCTION_SLOT]!.role).toBe("developer");
  });

  test("the instruction holds its slot in all three states", async () => {
    // One request at a time: each one writes the configuration the next server reads.
    const bodies = [
      await upstreamBodyFor({}),
      await upstreamBodyFor({ foldDeveloperRoleToSystem: true }),
      await upstreamBodyFor({ foldDeveloperRoleToSystem: false }),
    ];

    for (const body of bodies) {
      const messages = upstreamMessages(body);
      expect(messages).toHaveLength(CONVERSATION.length);
      expect(messages[INSTRUCTION_SLOT]!.content).toBe(CONVERSATION[INSTRUCTION_SLOT]!.content);
      expect(String(messages[0]!.content)).not.toContain(CONVERSATION[INSTRUCTION_SLOT]!.content);
    }
  });

  test("the route remains a passthrough rather than a translation", async () => {
    const body = await upstreamBodyFor({ foldDeveloperRoleToSystem: true });

    expect(body.model).toBe("test-model");
    expect(body).not.toHaveProperty("input");
    expect(body).not.toHaveProperty("instructions");
  });
});
