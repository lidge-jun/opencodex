/**
 * Client config panel (devlog 260731_client_config_export/040) — accept criteria 1-6.
 *
 * The panel renders what GET /api/client-config returns, so every assertion here drives the
 * real component against a stubbed route rather than a locally rebuilt config.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ClientConfigPanel from "../src/components/apikeys-workspace/ClientConfigPanel";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const OPENCODE_ENVELOPE = {
  client: "opencode",
  filename: "opencode.json",
  destination: "/home/dev/.config/opencode/opencode.json",
  apiKeyEnv: "OPENCODEX_OPENCODE_API_KEY",
  exportHint: "export OPENCODEX_OPENCODE_API_KEY=<your key>",
  modelCount: 2,
  modelsWithoutLimits: 0,
  config: {
    provider: {
      opencodex: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenCodex",
        options: { baseURL: "http://127.0.0.1:10100/v1", apiKey: "{env:OPENCODEX_OPENCODE_API_KEY}" },
        models: { "gpt-5.4": { name: "gpt-5.4 (native)" } },
      },
    },
  },
};

const PI_ENVELOPE = {
  client: "pi",
  filename: "pi-models.json",
  destination: "/home/dev/.pi/agent/models.json",
  apiKeyEnv: "OPENCODEX_PI_API_KEY",
  exportHint: "export OPENCODEX_PI_API_KEY=<your key>",
  modelCount: 2,
  modelsWithoutLimits: 1,
  // Pi keys its models as an ARRAY — the shape swap is what proves a real refetch.
  config: { providers: { opencodex: { models: [{ id: "gpt-5.4" }, { id: "claude-sonnet-4-6" }] } } },
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function stubRoute(handler: (client: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const client = url.searchParams.get("client") ?? "";
    calls.push(client);
    return handler(client);
  }) as typeof fetch;
  return calls;
}

async function mountPanel(props: { hasKeys?: boolean } = {}): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ClientConfigPanel
          apiBase=""
          baseUrl="http://127.0.0.1:10100/v1"
          hasKeys={props.hasKeys ?? true}
        />
      </LanguageProvider>,
    );
  });
  return { root, container };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(el => el.textContent?.trim() === label)!;
}

test("switching client refetches and swaps the rendered payload shape", async () => {
  const calls = stubRoute(client => Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel();

  const opencodeJson = container.querySelector(".awi-clientconfig-json")!.textContent!;
  expect(opencodeJson).toContain("\"provider\"");
  expect(JSON.parse(opencodeJson)).toEqual(OPENCODE_ENVELOPE.config);

  await act(async () => { button(container, "Pi").click(); });

  expect(calls).toEqual(["opencode", "pi"]);
  const piJson = container.querySelector(".awi-clientconfig-json")!.textContent!;
  const parsed = JSON.parse(piJson) as typeof PI_ENVELOPE.config;
  expect(Array.isArray(parsed.providers.opencodex.models)).toBe(true);
  expect(piJson).not.toContain("\"npm\"");

  await act(async () => { root.unmount(); });
});

test("download emits the fetched config under the server-provided filename and never says applied", async () => {
  stubRoute(() => Response.json(OPENCODE_ENVELOPE));
  const blobs: Blob[] = [];
  const createObjectURL = ((blob: Blob) => { blobs.push(blob); return "blob:stub"; }) as typeof URL.createObjectURL;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

  const downloaded: string[] = [];
  const originalCreateElement = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const element = originalCreateElement(tag);
    if (tag === "a") {
      // The anchor is an internal implementation detail; happy-dom does not navigate on click.
      (element as HTMLAnchorElement).click = () => { downloaded.push((element as HTMLAnchorElement).download); };
    }
    return element;
  }) as typeof document.createElement;

  try {
    const { root, container } = await mountPanel();
    await act(async () => { button(container, "Download").click(); });

    expect(downloaded).toEqual(["opencode.json"]);
    expect(blobs).toHaveLength(1);
    // happy-dom appends `;charset=utf-8` to the constructed Blob type.
    expect(blobs[0]!.type).toStartWith("application/json");
    expect(JSON.parse(await blobs[0]!.text())).toEqual(OPENCODE_ENVELOPE.config);

    const announcement = container.querySelector(".sr-only[aria-live='polite']")!.textContent!;
    expect(announcement).toContain("Downloaded opencode.json");
    expect(announcement).toContain(OPENCODE_ENVELOPE.destination);
    for (const forbidden of ["applied", "saved", "configured"]) {
      expect(announcement.toLowerCase()).not.toContain(forbidden);
    }
    // Merge semantics are stated on the surface, not only in the announcement (003 §5).
    expect(container.textContent).toContain("Merge this into the destination file.");

    await act(async () => { root.unmount(); });
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    document.createElement = originalCreateElement as typeof document.createElement;
  }
});

test("route failure shows a retry and no partial JSON, and keeps the base URL visible", async () => {
  let attempt = 0;
  stubRoute(() => {
    attempt += 1;
    return attempt === 1
      ? Response.json({ error: "model catalog unavailable: upstream timeout" }, { status: 503 })
      : Response.json(OPENCODE_ENVELOPE);
  });
  const { root, container } = await mountPanel();

  expect(container.textContent).toContain("model catalog unavailable: upstream timeout");
  expect(container.querySelector(".awi-clientconfig-json")).toBeNull();
  expect(container.textContent).toContain("http://127.0.0.1:10100/v1");

  await act(async () => { button(container, "Retry").click(); });

  expect(attempt).toBe(2);
  expect(container.querySelector(".awi-clientconfig-json")).not.toBeNull();
  expect(container.querySelector(".awi-clientconfig-error")).toBeNull();

  await act(async () => { root.unmount(); });
});

test("degraded line appears only when models ship without context limits", async () => {
  stubRoute(client => Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel();

  expect(container.querySelector(".awi-clientconfig-degraded")).toBeNull();

  await act(async () => { button(container, "Pi").click(); });

  expect(container.querySelector(".awi-clientconfig-degraded")?.textContent)
    .toBe("1 of 2 model(s) ship without a context limit; the client applies its own defaults.");

  await act(async () => { root.unmount(); });
});

test("no-key state is informational and leaves copy and download enabled", async () => {
  stubRoute(() => Response.json(OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel({ hasKeys: false });

  expect(container.querySelector(".awi-clientconfig-nokey")?.textContent)
    .toContain("OPENCODEX_OPENCODE_API_KEY has no key behind it yet");
  expect(button(container, "Copy JSON").disabled).toBe(false);
  expect(button(container, "Download").disabled).toBe(false);

  await act(async () => { root.unmount(); });
});

test("client switch is a segmented radio group with both options visible, not a dropdown", async () => {
  stubRoute(() => Response.json(OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel();

  const group = container.querySelector(".awi-clientconfig-segmented")!;
  expect(group.getAttribute("role")).toBe("radiogroup");
  expect(container.querySelector("select")).toBeNull();
  const options = [...group.querySelectorAll("button[role='radio']")];
  expect(options.map(el => el.textContent)).toEqual(["OpenCode", "Pi"]);
  expect(options.map(el => el.getAttribute("aria-checked"))).toEqual(["true", "false"]);

  await act(async () => { root.unmount(); });
});

test("cold load announces through the skeleton only, with no second live region", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { release = resolve; });
  stubRoute(async () => { await gate; return Response.json(OPENCODE_ENVELOPE); });

  const { root, container } = await mountPanel();

  const liveRegions = container.querySelectorAll("[aria-live]");
  expect(liveRegions).toHaveLength(1);
  expect(container.querySelector(".data-surface-skeleton")).not.toBeNull();
  expect(container.querySelector(".awi-clientconfig-json")).toBeNull();

  await act(async () => { release!(); await gate; });

  expect(container.querySelector(".data-surface-skeleton")).toBeNull();
  expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);

  await act(async () => { root.unmount(); });
});
