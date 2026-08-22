import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { LanguageProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/en";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: { url: string; init?: RequestInit }[] = [];
let roles: Array<Record<string, unknown>> = [];
let injectionPrompt: string | null = null;
let childInstructions: string | null = null;
let multiAgentMode: "v1" | "default" | "v2" = "default";
let keepNativeChatGptOnV1 = false;
let storedSync: boolean | undefined;
let rolesPutError: string | null = null;

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const available = [
  { provider: "openai", model: "gpt-5.6-luna", namespaced: "gpt-5.6-luna" },
  { provider: "anthropic", model: "claude-sonnet-5", namespaced: "anthropic/claude-sonnet-5" },
  { provider: "openrouter", model: "gpt-5.4", namespaced: "openrouter/gpt-5.4" },
];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  requests = [];
  roles = [];
  injectionPrompt = null;
  childInstructions = null;
  multiAgentMode = "default";
  keepNativeChatGptOnV1 = false;
  storedSync = undefined;
  rolesPutError = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const path = new URL(String(url), "http://localhost/").pathname;
      if (path === "/api/v2") {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body ?? "{}")) as { subagentDeveloperInstructions?: string | null };
          if ("subagentDeveloperInstructions" in body) childInstructions = body.subagentDeveloperInstructions ?? null;
          return response({ ok: true, subagentDeveloperInstructions: childInstructions });
        }
        return response({
          enabled: true,
          multiAgentMode,
          keepNativeChatGptOnV1,
          multiAgentModeHintText: null,
          subagentDeveloperInstructions: childInstructions,
        });
      }
      if (path === "/api/subagent-models") return response({ available: ["gpt-5.6-luna"], chosen: [] });
      if (path === "/api/injection-model") {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body ?? "{}")) as { prompt?: string | null };
          if ("prompt" in body) injectionPrompt = body.prompt ?? null;
          return response({ ok: true, prompt: injectionPrompt, available, efforts: ["low", "medium", "high"] });
        }
        return response({ available, efforts: ["low", "medium", "high"], prompt: injectionPrompt });
      }
      if (path === "/api/subagent-roles") {
        if (init?.method === "PUT") {
          if (rolesPutError) {
            return response({ error: rolesPutError }, false, 400);
          }
          const body = JSON.parse(String(init.body ?? "{}")) as {
            roles?: Array<Record<string, unknown>>;
            syncCodexAgentRoles?: boolean;
          };
          if (Array.isArray(body.roles)) roles = body.roles;
          if (typeof body.syncCodexAgentRoles === "boolean") storedSync = body.syncCodexAgentRoles;
          return response({
            ok: true,
            roles,
            ...(storedSync === undefined ? {} : { syncCodexAgentRoles: storedSync }),
            syncCodexAgentRolesEffective: storedSync === false ? false : roles.some(role => role.enabled !== false),
            warnings: [],
          });
        }
        return response({
          roles,
          available,
          efforts: ["low", "medium", "high"],
          ...(storedSync === undefined ? {} : { syncCodexAgentRoles: storedSync }),
          syncCodexAgentRolesEffective: storedSync === false ? false : roles.some(role => role.enabled !== false),
        });
      }
      return response({});
    },
  });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Subagents apiBase="" />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find(candidate => (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim() === label);
  if (!button) throw new Error(`button not found: ${label}`);
  return button as unknown as HTMLButtonElement;
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = element.tagName === "TEXTAREA"
    ? testWindow.HTMLTextAreaElement.prototype
    : testWindow.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

test("adds a role, caps at eight, and saves the PUT body without persisting unset sync", async () => {
  await mount();

  await act(async () => { buttonByLabel(en["sub.roles.add"]).click(); });

  const idInput = container.querySelector<HTMLInputElement>(`input[aria-label="${en["sub.roles.id"]}"]`);
  const descriptionInput = container.querySelector<HTMLInputElement>(`input[aria-label="${en["sub.roles.description"]}"]`);
  const instructions = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${en["sub.roles.instructions"]}"]`);
  expect(idInput).toBeTruthy();
  await act(async () => {
    setInputValue(idInput!, "reviewer");
    setInputValue(descriptionInput!, "PR review");
    setInputValue(instructions!, "Review the diff.");
  });

  await act(async () => { buttonByLabel(en["sub.roles.save"]).click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  const put = requests.find(row => row.url.includes("/api/subagent-roles") && row.init?.method === "PUT");
  expect(put).toBeDefined();
  const body = JSON.parse(String(put!.init!.body)) as Record<string, unknown>;
  expect(body).toMatchObject({
    roles: [expect.objectContaining({
      id: "reviewer",
      description: "PR review",
      developerInstructions: "Review the diff.",
    })],
  });
  expect(body).not.toHaveProperty("syncCodexAgentRoles");

  for (let i = 0; i < 7; i++) {
    await act(async () => { buttonByLabel(en["sub.roles.add"]).click(); });
  }
  expect(buttonByLabel(en["sub.roles.add"]).disabled).toBe(true);
  await act(async () => {
    buttonByLabel(en["sub.roles.add"]).dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }));
  });
  expect(container.querySelectorAll(`input[aria-label="${en["sub.roles.id"]}"]`).length).toBe(8);
});

test("injection prompt textarea patches /api/injection-model", async () => {
  await mount();

  const textarea = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${en["sub.injectionPrompt"]}"]`);
  expect(textarea).toBeTruthy();
  await act(async () => {
    setInputValue(textarea!, "Use {{roles}} and {{model}}.");
  });
  const save = Array.from(container.querySelectorAll("button"))
    .find(button => button.getAttribute("aria-label") === en["sub.injectionPromptSave"]);
  expect(save).toBeTruthy();
  await act(async () => { (save as HTMLButtonElement).click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  const put = requests.find(row => row.url.includes("/api/injection-model") && row.init?.method === "PUT");
  expect(put).toBeDefined();
  expect(JSON.parse(String(put!.init!.body))).toEqual({ prompt: "Use {{roles}} and {{model}}." });
});

test("child instructions textarea patches /api/v2", async () => {
  await mount();
  const textarea = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${en["sub.childInstructions"]}"]`);
  expect(textarea).toBeTruthy();
  await act(async () => { setInputValue(textarea!, "Always cite files."); });
  await act(async () => { buttonByLabel(en["sub.childInstructionsSave"]).click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const put = requests.find(row => row.url.includes("/api/v2") && row.init?.method === "PUT");
  expect(put).toBeDefined();
  expect(JSON.parse(String(put!.init!.body))).toEqual({ subagentDeveloperInstructions: "Always cite files." });
});

test("sync toggle PUTs an explicit false rather than echoing effective on", async () => {
  roles = [{
    id: "reviewer",
    description: "PR review",
    model: "gpt-5.6-luna",
    developerInstructions: "Review.",
    enabled: true,
  }];
  await mount();
  const toggle = Array.from(container.querySelectorAll("button"))
    .find(button => button.getAttribute("aria-label") === en["sub.roles.sync"]);
  expect(toggle).toBeTruthy();
  expect(toggle!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => { (toggle as HTMLButtonElement).click(); });
  await act(async () => { buttonByLabel(en["sub.roles.save"]).click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const put = [...requests].reverse().find(row => row.url.includes("/api/subagent-roles") && row.init?.method === "PUT");
  expect(JSON.parse(String(put!.init!.body))).toMatchObject({ syncCodexAgentRoles: false });
});

test("openrouter/gpt-* on v2 shows the routed-child warning", async () => {
  multiAgentMode = "v2";
  roles = [{
    id: "reviewer",
    description: "PR review",
    model: "openrouter/gpt-5.4",
    developerInstructions: "Review.",
    enabled: true,
  }];
  await mount();
  expect(container.textContent).toContain(en["sub.roles.routedV2Warning"]);
});

test("keepNativeChatGptOnV1 suppresses the routed-child warning", async () => {
  multiAgentMode = "v2";
  keepNativeChatGptOnV1 = true;
  roles = [{
    id: "reviewer",
    description: "PR review",
    model: "openrouter/gpt-5.4",
    developerInstructions: "Review.",
    enabled: true,
  }];
  await mount();
  expect(container.textContent).not.toContain(en["sub.roles.routedV2Warning"]);
});

test("roles PUT 400 surfaces the server error", async () => {
  rolesPutError = "invalid role id";
  await mount();
  await act(async () => { buttonByLabel(en["sub.roles.add"]).click(); });
  const idInput = container.querySelector<HTMLInputElement>(`input[aria-label="${en["sub.roles.id"]}"]`);
  await act(async () => { setInputValue(idInput!, "bad id"); });
  await act(async () => { buttonByLabel(en["sub.roles.save"]).click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(container.textContent).toContain("invalid role id");
});
