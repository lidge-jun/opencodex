/**
 * Account pool settings collapse to their header (#fb-2100): by default only the card title and its
 * on/off switch are visible, everything else sits in a keyboard-reachable disclosure that remembers
 * being opened per card. The switch keeps working while the details are closed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import AnthropicAccountPoolSettings from "../src/components/provider-workspace/AnthropicAccountPoolSettings";
import { CodexAutoSwitchSetting } from "../src/components/CodexAutoSwitchSetting";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS } from "../src/i18n/shared";

const en = DICTS.en;
const domGlobals = ["document", "window", "navigator", "fetch", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let mountedRoots: Root[];

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  mountedRoots = [];
});

afterEach(async () => {
  for (const root of mountedRoots) await act(async () => { root.unmount(); });
  for (const key of domGlobals) {
    const descriptor = previousDomGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  await testWindow.happyDOM?.close?.();
});

/** GET answers per provider; PUT echoes the body and is counted. */
function stubPool(enabled: boolean | "fail" = true): { puts: Array<Record<string, unknown>> } {
  const calls = { puts: [] as Array<Record<string, unknown>> };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("/api/pool/settings")) throw new Error("unexpected fetch " + String(input));
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.puts.push(body);
      return Response.json(body);
    }
    if (enabled === "fail") return new Response(null, { status: 500 });
    return Response.json({ enabled, strategy: "quota", stickyLimit: 1, quotaWindow: "five-hour", autoSwitchThreshold: 80 });
  }) as typeof fetch;
  return calls;
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(<LanguageProvider>{node}</LanguageProvider>);
  });
  await act(async () => { await flush(); });
  return host as unknown as HTMLElement;
}

const claudeCard = (provider: "anthropic" | "anthropic2" = "anthropic", accountCount = 2) => (
  <AnthropicAccountPoolSettings apiBase="http://proxy" provider={provider} accountCount={accountCount} />
);

function disclosure(host: HTMLElement, title: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"))
    .find(candidate => candidate.textContent?.includes(title));
  if (!button) throw new Error("no disclosure button titled " + title);
  return button;
}

function body(host: HTMLElement, button: HTMLButtonElement): HTMLElement {
  const id = button.getAttribute("aria-controls");
  expect(id).toBeTruthy();
  const region = host.ownerDocument.getElementById(id!) as HTMLElement | null;
  expect(region).not.toBeNull();
  return region!;
}

/** Text a person can see: everything outside elements carrying the hidden attribute. */
function visibleText(root: Element): string {
  let out = "";
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) out += node.textContent ?? "";
    else if (node.nodeType === 1 && !(node as Element).hasAttribute("hidden")) out += visibleText(node as Element);
  }
  return out;
}

const switchOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button.toggle[aria-pressed]")!;

describe("Claude account pool card", () => {
  test("shows only the title and the switch until its details are opened", async () => {
    stubPool(true);
    const host = await render(claudeCard());
    const button = disclosure(host, en["anthropicPool.title"]);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(body(host, button).hasAttribute("hidden")).toBe(true);

    const seen = visibleText(host);
    expect(seen).toContain(en["anthropicPool.title"]);
    expect(seen).not.toContain(en["anthropicPool.experimentalWarning"]);
    expect(seen).not.toContain(en["anthropicPool.detailsSummary"]);
    expect(seen).not.toContain(en["anthropicPool.threshold"]);
    expect(seen).not.toContain(en["accountPool.strategy"]);
    expect(seen).not.toContain(en["accountPool.quotaWindow"]);
    expect(switchOf(host).getAttribute("aria-pressed")).toBe("true");
  });

  test("the switch saves while the details stay closed", async () => {
    const calls = stubPool(true);
    const host = await render(claudeCard());
    await act(async () => { switchOf(host).click(); await flush(); });
    expect(calls.puts).toHaveLength(1);
    expect(calls.puts[0]!.enabled).toBe(false);
    expect(switchOf(host).getAttribute("aria-pressed")).toBe("false");
    expect(body(host, disclosure(host, en["anthropicPool.title"])).hasAttribute("hidden")).toBe(true);
  });

  test("the disclosure button opens the details and the choice survives a remount", async () => {
    stubPool(true);
    const host = await render(claudeCard());
    const button = disclosure(host, en["anthropicPool.title"]);
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    await act(async () => { button.click(); await flush(); });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(body(host, button).hasAttribute("hidden")).toBe(false);
    expect(visibleText(host)).toContain(en["anthropicPool.experimentalWarning"]);
    expect(visibleText(host)).toContain(en["anthropicPool.threshold"]);

    const again = await render(claudeCard());
    expect(disclosure(again, en["anthropicPool.title"]).getAttribute("aria-expanded")).toBe("true");
    // Pool 2 is its own card with its own remembered state.
    const pool2 = await render(claudeCard("anthropic2"));
    expect(disclosure(pool2, en["anthropicPool.title"]).getAttribute("aria-expanded")).toBe("false");
  });

  test("two cards opened one after the other both stay open after a remount", async () => {
    stubPool(true);
    const first = await render(claudeCard("anthropic"));
    const second = await render(claudeCard("anthropic2"));
    await act(async () => { disclosure(first, en["anthropicPool.title"]).click(); await flush(); });
    await act(async () => { disclosure(second, en["anthropicPool.title"]).click(); await flush(); });
    const firstAgain = await render(claudeCard("anthropic"));
    const secondAgain = await render(claudeCard("anthropic2"));
    expect(disclosure(firstAgain, en["anthropicPool.title"]).getAttribute("aria-expanded")).toBe("true");
    expect(disclosure(secondAgain, en["anthropicPool.title"]).getAttribute("aria-expanded")).toBe("true");
  });

  test("a failed load stays visible while the details are closed, since it disables the switch", async () => {
    stubPool("fail");
    const host = await render(claudeCard());
    expect(switchOf(host).disabled).toBe(true);
    expect(visibleText(host)).toContain(en["anthropicPool.loadFailed"]);
  });

  test("the two-account requirement stays visible while it is what disables the switch", async () => {
    stubPool(false);
    const host = await render(claudeCard("anthropic", 1));
    expect(switchOf(host).disabled).toBe(true);
    expect(visibleText(host)).toContain(en["anthropicPool.needTwoAccounts"]);
  });

  test("closing the details closes an open strategy menu and returns focus to the disclosure", async () => {
    stubPool(true);
    const host = await render(claudeCard());
    const button = disclosure(host, en["anthropicPool.title"]);
    await act(async () => { button.click(); await flush(); });
    const trigger = host.querySelector<HTMLButtonElement>("#anthropic-pool-strategy")!;
    await act(async () => { trigger.click(); await flush(); });
    expect(testWindow.document.querySelector('[role="listbox"]')).not.toBeNull();
    // A bare click: no mousedown, as assistive technology or a synthetic activation sends it.
    await act(async () => { button.click(); await flush(); });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(testWindow.document.querySelector('[role="listbox"]')).toBeNull();
    expect(testWindow.document.activeElement).toBe(button as never);
  });
});

describe("Codex usage-based switching card", () => {
  function Harness({ commits, threshold = 80 }: { commits: string[]; threshold?: number }) {
    const [draft, setDraft] = useState(String(threshold));
    const [editing, setEditing] = useState(false);
    return (
      <>
        <CodexAutoSwitchSetting
          threshold={threshold}
          draft={draft}
          saving={false}
          loadError={false}
          feedback={null}
          onDraftChange={setDraft}
          onEditingChange={setEditing}
          onCommit={async () => { commits.push(draft); return true; }}
          onCancel={() => {}}
          onToggle={async () => { commits.push("toggle"); return true; }}
          onRetry={() => {}}
        />
        <output data-testid="editing">{String(editing)}</output>
      </>
    );
  }

  test("shows only its title and switch; descriptions and threshold sit behind the disclosure", async () => {
    const commits: string[] = [];
    const host = await render(<Harness commits={commits} />);
    const button = disclosure(host, en["codexAuth.autoSwitch"]);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const region = body(host, button);
    expect(region.hasAttribute("hidden")).toBe(true);
    expect(region.querySelector('input[type="number"]')).not.toBeNull();
    const seen = visibleText(host);
    expect(seen).not.toContain(en["codexAuth.failureRecoveryNote"]);
    expect(seen).not.toContain(en["codexAuth.cacheWarning"]);
    expect(seen).not.toContain(en["codexAuth.autoSwitchThreshold"]);
    const toggle = switchOf(host);
    expect(region.contains(toggle)).toBe(false);
    await act(async () => { toggle.click(); await flush(); });
    expect(commits).toEqual(["toggle"]);
  });

  test("closing the details with a dirty threshold commits it and ends editing", async () => {
    const commits: string[] = [];
    const host = await render(<Harness commits={commits} />);
    const button = disclosure(host, en["codexAuth.autoSwitch"]);
    await act(async () => { button.click(); await flush(); });
    const input = body(host, button).querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "65");
      input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
      await flush();
    });
    expect(host.querySelector('[data-testid="editing"]')?.textContent).toBe("true");
    await act(async () => { button.click(); await flush(); });
    expect(commits).toEqual(["65"]);
    expect(host.querySelector('[data-testid="editing"]')?.textContent).toBe("false");
    expect(body(host, button).hasAttribute("hidden")).toBe(true);
    expect(testWindow.document.activeElement).toBe(button as never);
  });

  test("a load failure stays visible while the details are closed", async () => {
    const host = await render(
      <CodexAutoSwitchSetting threshold={80} draft="80" saving={false} loadError feedback={null}
        onDraftChange={() => {}} onEditingChange={() => {}} onCommit={async () => true} onCancel={() => {}}
        onToggle={async () => true} onRetry={() => {}} />,
    );
    expect(visibleText(host)).toContain(en["codexAuth.autoSwitchLoadFailed"]);
  });
});
