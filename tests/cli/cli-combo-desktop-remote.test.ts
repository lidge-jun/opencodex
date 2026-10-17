import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleComboCommand } from "../../src/cli/combo";
import { handleDesktopRemoteCommand, DESKTOP_REMOTE_SLOTS } from "../../src/cli/combo-desktop-remote";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
let network: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = createTempHome("ocx-desktop-remote-test-");
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network forbidden");
  });
});

afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  output.mockRestore();
  errors.mockRestore();
  network.mockRestore();
  home.remove();
});

interface MockServerState {
  combos: Array<{ id: string; alias?: string; nativeAlias?: boolean; displayName?: string; targets: Array<{ provider: string; model: string }> }>;
  providers: Array<{ name: string; models: string[] }>;
  syncCalled: boolean;
}

function createMockDeps(initialState: Partial<MockServerState> = {}) {
  const state: MockServerState = {
    combos: initialState.combos ?? [],
    providers: initialState.providers ?? [
      { name: "cursor", models: ["auto", "claude-opus-5-5"] },
      { name: "google", models: ["gemini-2.5-flash"] },
    ],
    syncCalled: false,
  };

  const calls: Array<{ url: string; method: string; body?: unknown }> = [];

  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => ({ pid: null, port: 10100, source: "runtime" }),
    fetchImpl: (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });

      if (url.includes("/api/combos") && method === "GET") {
        return Response.json({ combos: state.combos }, { status: 200 });
      }

      if (url.includes("/api/providers") && method === "GET") {
        return Response.json(state.providers, { status: 200 });
      }

      if (url.includes("/api/combos") && method === "PUT") {
        const id = body.id;
        const existingIdx = state.combos.findIndex(c => c.id === id);
        const saved = { id, ...body.combo };
        if (existingIdx >= 0) {
          state.combos[existingIdx] = saved;
        } else {
          state.combos.push(saved);
        }
        return Response.json({ ok: true, id }, { status: 200 });
      }

      if (url.includes("/api/combos") && method === "DELETE") {
        const parsedUrl = new URL(url);
        const id = parsedUrl.searchParams.get("id");
        state.combos = state.combos.filter(c => c.id !== id);
        return Response.json({ ok: true, id }, { status: 200 });
      }

      if (url.includes("/api/sync") && method === "POST") {
        state.syncCalled = true;
        return Response.json({ ok: true }, { status: 200 });
      }

      return Response.json({ ok: true }, { status: 200 });
    }) as typeof fetch,
  };

  return { deps, state, calls };
}

describe("ocx combo desktop-remote", () => {
  test("show displays slot mappings and remote SSH setup guidance", async () => {
    const { deps } = createMockDeps({
      combos: [
        {
          id: "desktop-sol",
          alias: "gpt-5.6-sol",
          nativeAlias: true,
          displayName: "Desktop Remote - Sol (cursor/auto)",
          targets: [{ provider: "cursor", model: "auto" }],
        },
      ],
    });

    const exitCode = await handleDesktopRemoteCommand(["show", "--json"], deps);
    expect(exitCode).toBe(0);

    const json = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(json.slots["gpt-5.6-sol"].active).toBe(true);
    expect(json.slots["gpt-5.6-sol"].target).toBe("cursor/auto");
    expect(json.slots["gpt-5.6-terra"].active).toBe(false);
    expect(json.remoteForward.port).toBe(10100);
    expect(json.remoteForward.sshConfig).toBe("RemoteForward 10100 127.0.0.1:10100");
  });

  test("apply with explicit targets creates combos and triggers sync", async () => {
    const { deps, state } = createMockDeps();

    const exitCode = await handleDesktopRemoteCommand(
      [
        "apply",
        "--sol", "cursor/auto",
        "--terra", "google/gemini-2.5-flash",
        "--luna", "cursor/claude-opus-5-5",
        "--json",
      ],
      deps,
    );
    expect(exitCode).toBe(0);

    expect(state.combos.length).toBe(3);
    const sol = state.combos.find(c => c.alias === "gpt-5.6-sol");
    expect(sol).toBeDefined();
    expect(sol?.nativeAlias).toBe(true);
    expect(sol?.targets[0]?.provider).toBe("cursor");
    expect(sol?.targets[0]?.model).toBe("auto");

    const terra = state.combos.find(c => c.alias === "gpt-5.6-terra");
    expect(terra).toBeDefined();
    expect(terra?.nativeAlias).toBe(true);
    expect(terra?.targets[0]?.provider).toBe("google");

    expect(state.syncCalled).toBe(true);
  });

  test("apply auto-discovers candidate models when flags are omitted", async () => {
    const { deps, state } = createMockDeps({
      providers: [
        { name: "cursor", models: ["auto", "claude-opus-5-5"] },
        { name: "google", models: ["gemini-2.5-flash"] },
      ],
    });

    const exitCode = await handleDesktopRemoteCommand(["apply", "--json"], deps);
    expect(exitCode).toBe(0);

    const sol = state.combos.find(c => c.alias === "gpt-5.6-sol");
    expect(sol?.targets[0]?.provider).toBe("cursor");
    expect(sol?.targets[0]?.model).toBe("auto");

    const terra = state.combos.find(c => c.alias === "gpt-5.6-terra");
    expect(terra?.targets[0]?.provider).toBe("google");
    expect(terra?.targets[0]?.model).toBe("gemini-2.5-flash");
  });

  test("clear requires --yes and deletes desktop-remote combos", async () => {
    const { deps, state } = createMockDeps({
      combos: [
        {
          id: "desktop-sol",
          alias: "gpt-5.6-sol",
          nativeAlias: true,
          targets: [{ provider: "cursor", model: "auto" }],
        },
      ],
    });

    const failCode = await handleDesktopRemoteCommand(["clear"], deps);
    expect(failCode).toBe(2);

    const successCode = await handleDesktopRemoteCommand(["clear", "--yes", "--json"], deps);
    expect(successCode).toBe(0);
    expect(state.combos.length).toBe(0);
    expect(state.syncCalled).toBe(true);
  });

  test("dispatches cleanly through handleComboCommand('desktop-remote')", async () => {
    const { deps } = createMockDeps();
    const exitCode = await handleComboCommand(["desktop-remote", "show", "--json"], deps);
    expect(exitCode).toBe(0);
  });
});
