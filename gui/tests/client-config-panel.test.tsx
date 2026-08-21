/**
 * Client config panel (devlog 260731_client_config_export/040, reshaped by 260802/010).
 *
 * The panel renders what GET /api/client-config returns, so every assertion here drives the
 * real component against a stubbed route rather than a locally rebuilt config.
 *
 * The client switch became one row per client, and the config bytes moved behind a
 * detail dialog. Each rewritten test below names the guard it carries forward, because
 * the invariants are unchanged even where the markup is not.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
  CLIENTS,
  CLIENT_LABEL_KEYS,
} from "../src/components/apikeys-workspace/client-config-clients";
import { LanguageProvider } from "../src/i18n/provider";
import ClientConfigPanel from "../src/components/apikeys-workspace/ClientConfigPanel";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const OPENCODE_ENVELOPE_BASE = {
  client: "opencode",
  filename: "opencode.json",
  destination: "/home/dev/.config/opencode/opencode.json",
  apiKeyEnv: "OPENCODEX_OPENCODE_API_KEY",
  exportHint: "export OPENCODEX_OPENCODE_API_KEY=<your key>",
  modelCount: 2,
  modelsWithoutLimits: 0,
  format: "json",
  mediaType: "application/json",
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

const PI_ENVELOPE_BASE = {
  client: "pi",
  filename: "pi-models.json",
  destination: "/home/dev/.pi/agent/models.json",
  apiKeyEnv: "OPENCODEX_PI_API_KEY",
  exportHint: "export OPENCODEX_PI_API_KEY=<your key>",
  modelCount: 2,
  modelsWithoutLimits: 1,
  format: "json",
  mediaType: "application/json",
  // Pi keys its models as an ARRAY — the shape swap is what proves a real refetch.
  config: { providers: { opencodex: { models: [{ id: "gpt-5.4" }, { id: "claude-sonnet-4-6" }] } } },
};

/**
 * `text` is the server-rendered bytes. Deriving it from `config` here keeps the
 * fixture honest: the dialog asserts it shows exactly what the route sent.
 */
const OPENCODE_ENVELOPE = {
  ...OPENCODE_ENVELOPE_BASE,
  text: `${JSON.stringify(OPENCODE_ENVELOPE_BASE.config, null, 2)}\n`,
};
const PI_ENVELOPE = {
  ...PI_ENVELOPE_BASE,
  text: `${JSON.stringify(PI_ENVELOPE_BASE.config, null, 2)}\n`,
};


/**
 * A TOML client. This fixture is the one that actually activates the non-JSON
 * path: `text` is not `JSON.stringify(config)`, so restoring the old
 * re-serializing implementation fails these assertions instead of passing.
 */
const KIMI_ENVELOPE = {
  client: "kimi",
  filename: "kimi-config.toml",
  destination: "/home/dev/.kimi-code/config.toml",
  apiKeyEnv: "",
  exportHint: "Kimi Code reads credentials from its config file; loopback needs no key.",
  modelCount: 1,
  modelsWithoutLimits: 0,
  format: "toml",
  mediaType: "application/toml",
  text: '[providers.opencodex]\ntype = "openai"\nbase_url = "http://127.0.0.1:10100/v1"\n',
  config: { providers: { opencodex: { type: "openai", base_url: "http://127.0.0.1:10100/v1" } } },
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

async function mountPanel(props: { hasKeys?: boolean; apiBase?: string } = {}): Promise<{
  root: Root;
  container: HTMLElement;
  /** Re-render with a different apiBase, which is part of a row's request identity. */
  rerender: (next: { apiBase: string }) => Promise<void>;
}> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const render = (apiBase: string) => (
    <LanguageProvider>
      <ClientConfigPanel
        apiBase={apiBase}
        baseUrl="http://127.0.0.1:10100/v1"
        hasKeys={props.hasKeys ?? true}
      />
    </LanguageProvider>
  );
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(render(props.apiBase ?? ""));
  });
  return {
    root,
    container,
    rerender: async ({ apiBase }) => { await act(async () => { root.render(render(apiBase)); }); },
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(el => el.textContent?.trim() === label)!;
}

/** The row whose visible name matches, so per-client assertions cannot cross rows. */
function row(container: HTMLElement, name: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>(".awi-clientconfig-row")]
    .find(el => el.querySelector(".awi-clientconfig-name")?.textContent === name)!;
}

function rowButton(container: HTMLElement, name: string, label: string): HTMLButtonElement {
  return [...row(container, name).querySelectorAll<HTMLButtonElement>("button")]
    .find(el => el.textContent?.trim() === label)!;
}

test("the API download surface includes DSH and MiniMax Code as clients", () => {
  expect(CLIENTS).toEqual(["opencode", "pi", "omp", "hermes", "openclaw", "kimi", "gajae", "dsh", "mcode", "zcode", "prime"]);
  expect(CLIENT_LABEL_KEYS.dsh).toBe("api.clientConfig.clientDsh");
  expect(CLIENT_LABEL_KEYS.mcode).toBe("api.clientConfig.clientMcode");
  expect(CLIENT_LABEL_KEYS.zcode).toBe("api.clientConfig.clientZcode");
});

test("each row fetches its own client and its dialog renders that client's exact bytes", async () => {
  // Carries the guard the client-switch test owned: payload identity per client.
  // Destination-only assertions would have lost it.
  const calls = stubRoute(client => Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel();

  expect([...calls].sort()).toEqual([...CLIENTS].sort());

  await act(async () => { rowButton(container, "OpenCode", "Details").click(); });
  const opencodeJson = container.querySelector(".awi-clientconfig-json")!.textContent!;
  expect(JSON.parse(opencodeJson)).toEqual(OPENCODE_ENVELOPE.config);
  await act(async () => { button(container, "Close").click(); });

  await act(async () => { rowButton(container, "Pi", "Details").click(); });
  const piJson = container.querySelector(".awi-clientconfig-json")!.textContent!;
  const parsed = JSON.parse(piJson) as typeof PI_ENVELOPE.config;
  expect(parsed).toEqual(PI_ENVELOPE.config);
  expect(Array.isArray(parsed.providers.opencodex.models)).toBe(true);
  expect(piJson).not.toContain("\"npm\"");

  await act(async () => { root.unmount(); });
});

test("the config bytes are not rendered at rest", async () => {
  // The core of the request: rows carry the actions, not the payload.
  stubRoute(client => Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel();

  expect(container.querySelectorAll(".awi-clientconfig-row")).toHaveLength(CLIENTS.length);
  expect(container.querySelector(".awi-clientconfig-json")).toBeNull();
  expect(container.querySelector("dialog")).toBeNull();
  // Both transport actions stay on the surface; only inspection is demoted.
  expect(rowButton(container, "OpenCode", "Copy config").disabled).toBe(false);
  expect(rowButton(container, "OpenCode", "Download").disabled).toBe(false);

  await act(async () => { rowButton(container, "OpenCode", "Details").click(); });
  expect(container.querySelector(".awi-clientconfig-json")).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("clients render as rows, not a switch", async () => {
  stubRoute(client => Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel();

  expect(container.querySelector("[role='radiogroup']")).toBeNull();
  expect(container.querySelector("select")).toBeNull();
  expect(container.querySelector(".awi-clientconfig-segmented")).toBeNull();
  const names = [...container.querySelectorAll(".awi-clientconfig-name")].map(el => el.textContent);
  // Row order follows the registry, so a new client appears without a code change here.
  expect(names?.slice(0, 2)).toEqual(["OpenCode", "Pi"]);
  expect(names).toHaveLength(CLIENTS.length);
  // Each row states where its file goes; a Download with no destination is the
  // ambiguity the announcement text works to prevent.
  expect(row(container, "OpenCode").textContent).toContain(OPENCODE_ENVELOPE.destination);
  expect(row(container, "Pi").textContent).toContain(PI_ENVELOPE.destination);

  await act(async () => { root.unmount(); });
});

test("row actions carry client-qualified accessible names", async () => {
  // Two rows means duplicate visible labels; without qualification a screen
  // reader's button list is four ambiguous entries.
  stubRoute(client => Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel();

  expect(rowButton(container, "Pi", "Copy config").getAttribute("aria-label")).toBe("Copy Pi config");
  expect(rowButton(container, "Pi", "Download").getAttribute("aria-label")).toBe("Download Pi config");
  expect(rowButton(container, "Pi", "Details").getAttribute("aria-label")).toBe("Pi config details");
  expect(container.querySelector(".awi-clientconfig-rows")?.getAttribute("aria-label")).toBe("Connect a client");

  await act(async () => { root.unmount(); });
});

test("dialog closes on Escape and returns focus to its trigger", async () => {
  stubRoute(client => Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel();

  const trigger = rowButton(container, "OpenCode", "Details");
  await act(async () => { trigger.click(); });
  const dialog = container.querySelector("dialog")!;
  expect(dialog).not.toBeNull();
  expect(dialog.getAttribute("aria-labelledby")).toBe("awi-clientconfig-dialog-opencode");

  // Escape reaches a native dialog as `cancel`. happy-dom rejects an Event built
  // from the outer realm's constructor, so build it from the test window's.
  const WindowEvent = (testWindow as unknown as { Event: typeof Event }).Event;
  await act(async () => { dialog.dispatchEvent(new WindowEvent("cancel", { bubbles: false, cancelable: true })); });

  expect(container.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await act(async () => { root.unmount(); });
});

test("each client row shows its own brand mark, never a borrowed one", async () => {
  // OpenCode and Pi ship real assets; the clients added later have none yet and
  // fall back to a monogram tile. The rule this guards is that no client ever
  // borrows another product's logo — not that every client has an asset.
  stubRoute(client => Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel();

  expect(row(container, "OpenCode").querySelector("img")?.getAttribute("src"))
    .toBe("/provider-icons/opencode.svg");
  expect(row(container, "Pi").querySelector("img")?.getAttribute("src"))
    .toBe("/provider-icons/pi.svg");
  // Every rendered mark belongs to the client whose row it sits in.
  const sources = [...container.querySelectorAll("img")]
    .map(img => img.getAttribute("src"))
    .filter((src): src is string => src !== null);
  expect(new Set(sources).size).toBe(sources.length);
  // Marks are decoration: the row already names its client in text.
  for (const img of container.querySelectorAll("img")) {
    expect(img.getAttribute("alt")).toBe("");
  }

  await act(async () => { root.unmount(); });
});

test("the backdrop dismisses the dialog and also returns focus", async () => {
  // Escape and Close were covered; the backdrop is the third way out and had no
  // assertion, so a regression there would have shipped silently.
  stubRoute(client => Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel();

  const trigger = rowButton(container, "OpenCode", "Details");
  await act(async () => { trigger.click(); });
  const backdrop = container.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!;
  expect(backdrop).not.toBeNull();
  // Never a tab stop: it is a click target behind the card, not a control.
  expect(backdrop.tabIndex).toBe(-1);

  await act(async () => { backdrop.click(); });

  expect(container.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await act(async () => { root.unmount(); });
});

test("a superseded response never replaces a newer one", async () => {
  // `apiBase` is part of a row's request identity. Before it was, a result from
  // the previous origin still matched the key and stayed copyable while the
  // replacement request was in flight.
  let releaseSlow: (() => void) | null = null;
  const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const client = url.searchParams.get("client") ?? "";
    const origin = url.origin;
    seen.push(`${origin}:${client}`);
    const envelope = client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE;
    // The FIRST origin answers late, after the second has already settled.
    if (origin === "http://localhost") {
      await slow;
      return Response.json({ ...envelope, destination: "/stale/path.json" });
    }
    return Response.json(envelope);
  }) as typeof fetch;

  const { root, container, rerender } = await mountPanel();
  await rerender({ apiBase: "http://127.0.0.1:9999" });
  expect(row(container, "OpenCode").textContent).toContain(OPENCODE_ENVELOPE.destination);

  // The first origin's reply lands now. It must not overwrite the newer result.
  await act(async () => { releaseSlow!(); await slow; });

  expect(row(container, "OpenCode").textContent).toContain(OPENCODE_ENVELOPE.destination);
  expect(container.textContent).not.toContain("/stale/path.json");

  await act(async () => { root.unmount(); });
});

test("download emits the fetched config under the server-provided filename and never says applied", async () => {
  stubRoute(client => Response.json(client === "kimi" ? KIMI_ENVELOPE : OPENCODE_ENVELOPE));
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
    await act(async () => { rowButton(container, "OpenCode", "Download").click(); });

    expect(downloaded).toEqual(["opencode.json"]);
    expect(blobs).toHaveLength(1);
    // happy-dom appends `;charset=utf-8` to the constructed Blob type.
    expect(blobs[0]!.type).toStartWith("application/json");
    // The blob carries the server-rendered bytes verbatim — the GUI no longer
    // re-serializes, so a TOML client downloads TOML rather than JSON.
    expect(await blobs[0]!.text()).toBe(OPENCODE_ENVELOPE.text);

    const firstAnnouncement = container.querySelector(".sr-only[aria-live='polite']")!.textContent!;
    expect(firstAnnouncement).toContain("Downloaded opencode.json");

    // The TOML client is the case that actually distinguishes the two
    // implementations: its bytes are not JSON, so a re-serializing panel would
    // hand the user a file Kimi cannot parse.
    await act(async () => { rowButton(container, "Kimi Code", "Download").click(); });
    expect(downloaded).toEqual(["opencode.json", "kimi-config.toml"]);
    expect(blobs).toHaveLength(2);
    expect(blobs[1]!.type).toStartWith("application/toml");
    const tomlBytes = await blobs[1]!.text();
    expect(tomlBytes).toBe(KIMI_ENVELOPE.text);
    expect(tomlBytes).not.toBe(`${JSON.stringify(KIMI_ENVELOPE.config, null, 2)}\n`);
    expect(tomlBytes.startsWith("[providers.opencodex]")).toBe(true);

    const announcement = container.querySelector(".sr-only[aria-live='polite']")!.textContent!;
    expect(announcement).toContain("Downloaded kimi-config.toml");
    expect(announcement).toContain(KIMI_ENVELOPE.destination);
    for (const forbidden of ["applied", "saved", "configured"]) {
      expect(announcement.toLowerCase()).not.toContain(forbidden);
    }
    // Merge semantics moved into the dialog with the rest of the explanatory
    // copy, but they must still be reachable — this half of the original
    // assertion is retargeted, not dropped.
    expect(container.textContent).not.toContain("Merge this into the destination file.");
    await act(async () => { rowButton(container, "OpenCode", "Details").click(); });
    expect(container.querySelector("dialog")!.textContent).toContain("Merge this into the destination file.");

    await act(async () => { root.unmount(); });
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    document.createElement = originalCreateElement as typeof document.createElement;
  }
});

test("one client's failure isolates to its row, with no partial JSON and the base URL intact", async () => {
  // Carries three guards from the original failure test: no partial JSON, the
  // base URL survives, and retry works. Adds the new boundary: the failure
  // belongs to one row, so the sibling stays fully actionable.
  let piAttempts = 0;
  stubRoute(client => {
    if (client !== "pi") return Response.json(OPENCODE_ENVELOPE);
    piAttempts += 1;
    return piAttempts === 1
      ? Response.json({ error: "model catalog unavailable: upstream timeout" }, { status: 503 })
      : Response.json(PI_ENVELOPE);
  });
  const { root, container } = await mountPanel();

  expect(row(container, "Pi").textContent).toContain("Could not build the Pi config.");
  expect(container.querySelector(".awi-clientconfig-json")).toBeNull();
  expect(container.textContent).toContain("http://127.0.0.1:10100/v1");

  // The failed row offers repair and nothing else. Asserting only that no JSON
  // is on screen proves nothing here — successful rows render none either, so
  // that check passes whether or not the failure is isolated.
  expect([...row(container, "Pi").querySelectorAll("button")].map(b => b.textContent?.trim()))
    .toEqual(["Retry"]);

  // The sibling row is untouched by its neighbour's 503.
  expect(rowButton(container, "OpenCode", "Copy config").disabled).toBe(false);
  expect(rowButton(container, "OpenCode", "Download").disabled).toBe(false);

  await act(async () => { rowButton(container, "Pi", "Retry").click(); });

  expect(piAttempts).toBe(2);
  expect(row(container, "Pi").textContent).toContain(PI_ENVELOPE.destination);
  expect(rowButton(container, "Pi", "Copy config").disabled).toBe(false);

  await act(async () => { root.unmount(); });
});

test("degraded line appears only when models ship without context limits", async () => {
  // Retargeted into the dialog; the line must stay reachable, not stay put.
  stubRoute(client => Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel();

  await act(async () => { rowButton(container, "OpenCode", "Details").click(); });
  expect(container.querySelector(".awi-clientconfig-degraded")).toBeNull();
  await act(async () => { button(container, "Close").click(); });

  await act(async () => { rowButton(container, "Pi", "Details").click(); });
  expect(container.querySelector(".awi-clientconfig-degraded")?.textContent)
    .toBe("1 of 2 model(s) ship without a context limit; the client applies its own defaults.");

  await act(async () => { root.unmount(); });
});

test("no-key state is informational and leaves copy and download enabled", async () => {
  stubRoute(client => Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE));
  const { root, container } = await mountPanel({ hasKeys: false });

  // Row actions never block on a missing key: an agent may legitimately want the
  // shape first.
  expect(rowButton(container, "OpenCode", "Copy config").disabled).toBe(false);
  expect(rowButton(container, "OpenCode", "Download").disabled).toBe(false);

  await act(async () => { rowButton(container, "OpenCode", "Details").click(); });
  expect(container.querySelector(".awi-clientconfig-nokey")?.textContent)
    .toContain("OPENCODEX_OPENCODE_API_KEY has no key behind it yet");

  await act(async () => { root.unmount(); });
});

test("N rows still mean exactly one live region", async () => {
  // Strengthened from the cold-load version: the risk changed from "a skeleton
  // and an announcer speaking for the same transition" to "one announcer per
  // row", which would make every copy speak twice.
  let release: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { release = resolve; });
  stubRoute(async client => { await gate; return Response.json(client === "pi" ? PI_ENVELOPE : OPENCODE_ENVELOPE); });

  const { root, container } = await mountPanel();

  expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
  expect(container.querySelector(".awi-clientconfig-json")).toBeNull();
  // Rows exist while cold and state their own loading, without announcing it.
  expect(container.querySelectorAll(".awi-clientconfig-row")).toHaveLength(CLIENTS.length);

  await act(async () => { release!(); await gate; });

  expect(container.querySelector(".data-surface-skeleton")).toBeNull();
  expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);

  await act(async () => { root.unmount(); });
});
