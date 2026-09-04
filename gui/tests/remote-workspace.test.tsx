import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import { readPageFromHash } from "../src/app-routing";
import { remoteWorkspacePairingCommands } from "../src/remote-workspace-command";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const ROOT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

test("#remote resolves to the Remote Workspace page", () => {
  expect(readPageFromHash("#remote")).toBe("remote");
});

test("pairing commands use native POSIX and PowerShell syntax", () => {
  const commands = remoteWorkspacePairingCommands("ABCD-EFGH-JKLM", "https://hub.example.test/a'b");
  expect(commands.posix).toContain(`'https://hub.example.test/a'"'"'b'`);
  expect(commands.posix).toContain('--root "$PWD"');
  expect(commands.powershell).toContain("'https://hub.example.test/a''b'");
  expect(commands.powershell).toContain("--root (Get-Location).Path");
  expect(commands.powershell).toContain("$LASTEXITCODE -eq 0");
});

let win: Window;
let root: Root | null = null;
let previous: Record<string, unknown>;
const globals = ["window", "document", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#remote" });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win },
    document: { configurable: true, value: win.document },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
});

afterEach(async () => {
  if (root) {
    const current = root;
    const { act } = await import("react");
    await act(async () => current.unmount());
    root = null;
  }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

test("pairs a computer and starts a Hub-owned session for its selected folder", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let session: Record<string, unknown> | null = null;
  let releaseLongPrompt: (() => void) | null = null;
  const snapshot = () => ({
    available: true,
    devices: [{
      id: DEVICE_ID,
      name: "Computer 2",
      platform: "win32-x64",
      capabilities: ["workspace.read", "workspace.write"],
      roots: [{ id: ROOT_ID, label: "Project" }],
      online: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    }],
    runtimes: {
      codex: { available: true, version: "0.152.1" },
      claude: { available: true, version: "2.1.223" },
      pi: { available: true, version: "0.84.3" },
    },
    sessions: session ? [session] : [],
  });
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/api/remote-workspace") && method === "GET") return response(snapshot());
      if (url.endsWith("/pairing") && method === "POST") {
        return response({ code: "ABCD-EFGH-JKLM", expiresAt: "2026-01-01T00:10:00.000Z" }, 201);
      }
      if (url.endsWith("/sessions") && method === "POST") {
        session = {
          id: SESSION_ID,
          profile: "codex",
          accessMode: "read-only",
          deviceId: DEVICE_ID,
          deviceName: "Computer 2",
          rootId: ROOT_ID,
          rootLabel: "Project",
          capabilities: ["workspace.read"],
          tools: ["list_directory", "read_file"],
          threadId: "thread-1",
          resumable: true,
          status: "ready",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          events: [],
        };
        return response(session, 201);
      }
      if (url.endsWith(`/${SESSION_ID}/prompt`) && method === "POST") {
        const longPrompt = (body as { prompt?: string } | undefined)?.prompt === "Keep working";
        if (longPrompt) {
          await new Promise<void>(resolve => { releaseLongPrompt = resolve; });
        }
        const completed = {
          ...session,
          status: "ready",
          events: [{ sequence: 1, at: "2026-01-01T00:00:01.000Z", type: "assistant", text: "Remote work completed" }],
        };
        // Simulate a response captured before DELETE completed. It can arrive late, but the
        // server-side session remains stopped and the client must not resurrect its local copy.
        if (!longPrompt) session = completed;
        return response(completed);
      }
      if (url.endsWith(`/${SESSION_ID}`) && method === "DELETE") {
        session = { ...session, status: "stopped" };
        return response({ ok: true });
      }
      return response({ error: "unexpected request" }, 500);
    },
  });

  const [{ act }, { createRoot }, { default: RemoteWorkspace }, { LanguageProvider }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("../src/pages/RemoteWorkspace"),
    import("../src/i18n/provider"),
  ]);
  const host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><RemoteWorkspace apiBase="" /></LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  expect(host.textContent).toContain("Computer 2");
  expect(host.textContent).toContain("Codex");

  const button = (label: string) => [...host.querySelectorAll("button")].find(element => element.textContent?.includes(label)) as HTMLButtonElement;
  await act(async () => { button("Read only").click(); });
  expect(win.document.body.textContent).toContain("Edit files only");
  await act(async () => { button("Create pairing code").click(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(host.textContent).toContain("ABCD-EFGH-JKLM");
  expect(host.textContent).toContain("Linux / macOS terminal");
  expect(host.textContent).toContain("Windows PowerShell");

  await act(async () => { button("Start remote session").click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(host.textContent).toContain("Remote session is ready");
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Inspect the project");
    textarea.dispatchEvent(new win.Event("input", { bubbles: true }) as never);
  });
  await act(async () => { button("Send").click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(host.textContent).toContain("Remote work completed");
  expect(calls.some(call => call.method === "POST" && call.body && (call.body as { deviceId?: string }).deviceId === DEVICE_ID)).toBe(true);
  expect(calls.some(call => (call.body as { accessMode?: string } | undefined)?.accessMode === "read-only")).toBe(true);

  // A long prompt request must not disable Stop. The DELETE runs concurrently, and a late
  // prompt response must not replace the locally stopped state with a stale ready snapshot.
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Keep working");
    textarea.dispatchEvent(new win.Event("input", { bubbles: true }) as never);
  });
  await act(async () => { button("Send").click(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(button("Stop").disabled).toBe(false);
  await act(async () => { button("Stop").click(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(calls.some(call => call.method === "DELETE" && call.url.endsWith(`/${SESSION_ID}`))).toBe(true);
  await act(async () => { releaseLongPrompt?.(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(host.textContent).toContain("Stopped");
});
