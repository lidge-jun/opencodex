import { deepStrictEqual, ok } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dashboard = "http://127.0.0.1:15173";
const proxy = "http://127.0.0.1:18601";
const upstream = "http://127.0.0.1:18602";
const openai = ["openai", "openai-apikey", "anthropic", "anthropic-apikey"] as const;
const claude = ["anthropic", "anthropic-apikey", "openai", "openai-apikey"] as const;
const orders = { "openai-first": openai, "claude-first": claude } as const;
const timeout = 25_000;

async function eventually<T>(probe: () => T | Promise<T>, description: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== null && result !== undefined && result !== false) return result;
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for " + description);
}

function request(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
}

const identity = await (await request(upstream + "/healthz")).json();
deepStrictEqual(identity, { fixture: "opencodex-fallback", proxyPort: 18601 }, "Start the dedicated fallback fixture first.");
const chrome = process.env.CHROME_BIN ?? ["chromium", "google-chrome", "chrome"].map(name => Bun.which(name)).find(Boolean);
ok(chrome, "Set CHROME_BIN to an installed Chrome or Chromium executable.");
const home = await mkdtemp(join(tmpdir(), "ocx-fallback-browser-"));
await mkdir(join(home, "Default"));
await writeFile(join(home, "Default", "Preferences"), JSON.stringify({ intl: { accept_languages: "fr-FR,fr" } }));
const pageUrl = dashboard + "/#models/combos";
const browser = Bun.spawn([chrome, "--headless", "--disable-gpu", "--disable-background-networking", "--no-first-run",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--no-default-browser-check", "--disable-extensions", "--use-mock-keychain", "--lang=fr", "--window-size=1280,950",
  "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
  "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1;localhost",
  "--user-data-dir=" + home, pageUrl],
{ env: { ...((process.env.SystemRoot && process.platform === "win32") ? { SystemRoot: process.env.SystemRoot } : {}),
  HOME: home, USERPROFILE: home, TMPDIR: home }, stdout: "ignore", stderr: "ignore" });
let socket: WebSocket | undefined;
try {
  const port = await eventually(async () => (await readFile(join(home, "DevToolsActivePort"), "utf8")
    .catch(() => "")).match(/^\d+/)?.[0], "the isolated Chrome debugging port");
  const target = await eventually(async () => {
    const tabs = await (await request("http://127.0.0.1:" + port + "/json/list")).json() as Array<{ url: string; webSocketDebuggerUrl: string }>;
    return tabs.find(tab => tab.url === pageUrl);
  }, "the fixture page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  socket = ws;
  await eventually(() => ws.readyState === WebSocket.OPEN, "the Chrome connection");
  let commandId = 0;
  const pending = new Map<number, PromiseWithResolvers<unknown>>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const reply = pending.get(message.id);
    if (!reply) return;
    if (message.error) reply.reject(new Error(message.error.message));
    else reply.resolve(message.result);
  });
  async function cdp<T>(method: string, params = {}): Promise<T> {
    const id = ++commandId;
    const reply = Promise.withResolvers<unknown>();
    pending.set(id, reply);
    const timer = setTimeout(() => reply.reject(new Error("Chrome command timed out: " + method)), timeout);
    try { ws.send(JSON.stringify({ id, method, params })); return await reply.promise as T; }
    finally { clearTimeout(timer); pending.delete(id); }
  }
  async function evaluate<T>(code: string): Promise<T> {
    const answer = await cdp<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string } } }>(
      "Runtime.evaluate", { expression: code, returnByValue: true, awaitPromise: true })
      .catch(error => { throw new Error(String(error) + " while evaluating " + code.trim().slice(0, 110)); });
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? "Chrome evaluation failed");
    return answer.result.value;
  }
  const combos = async () => evaluate<Array<{ id: string; quotaOnlyFallback?: boolean; allowMeteredTargets?: boolean;
    targets: Array<{ provider: string; model: string; metered?: boolean }> }>>(
    "fetch('/api/combos').then(r => r.ok ? r.json().then(data => data.combos) : [])");
  await eventually(() => evaluate<boolean>("!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'OpenAI en premier')"),
    "the fixture Combo editor and its two presets").catch(async error => {
    const observation = await evaluate("[location.href, document.readyState, document.body?.innerText.slice(0, 1000)]");
    throw new Error(String(error) + " " + JSON.stringify(observation));
  });
  for (const id of ["openai-first", "claude-first"] as const) {
    const ordered = orders[id];
    for (const guided of [false, true]) {
      const comboId = guided ? id : "manual-" + id;
      const buttonText = guided ? id === "openai-first" ? "OpenAI en premier" : "Claude en premier" : "Ajouter une combinaison";
      const elapsed = performance.now();
      const actions = await evaluate<number>(`(async () => {
        let actions = 0;
        const find = (scope, selector, text) => [...scope.querySelectorAll(selector)].find(el => !text || el.textContent.trim() === text);
        const pause = () => new Promise(resolve => setTimeout(resolve, 25));
        const wait = async (probe, label) => {
          for (let i = 0; i < 200; i++) { const value = probe(); if (value) return value; await pause(); }
          throw new Error('Missing editor control: ' + label);
        };
        const click = async (scope, selector, text) => {
          const button = await wait(() => find(scope, selector, text), text || selector);
          if (button.disabled || button.getAttribute("aria-disabled") === "true") throw new Error('Disabled editor control: ' + text);
          button.click(); actions++; await pause();
        };
        await click(document, 'button', ${JSON.stringify(buttonText)});
        const dialog = await wait(() => document.querySelector('dialog[open]'), 'Ajouter une combinaison dialog');
        if (${!guided}) {
          const name = dialog.querySelector('#cwi-new-id');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(name, ${JSON.stringify(comboId)});
          name.dispatchEvent(new Event('input', { bubbles: true }));
          actions++; await pause();
          await click(dialog, '[role="switch"]', 'Basculer uniquement si le quota est épuisé');
          for (const [index, provider] of ${JSON.stringify(ordered)}.entries()) {
            if (index) await click(dialog, 'button', 'Ajouter une cible');
            const entry = dialog.querySelectorAll('.cwi-target-entry')[index];
            await click(entry, '[role="combobox"]');
            await click(document, '[role="option"][data-value="fixture-' + provider + '"]');
            if (provider.endsWith('-apikey')) {
              const billing = find(entry, '[data-paid]', 'API payante');
              if (!billing || entry.querySelector('[role="switch"]')) throw new Error('Known paid API was not protected.');
            }
          }
        }
        const consent = find(dialog, '[role="switch"]', 'Autoriser les appels payants des clients locaux');
        if (consent?.getAttribute('aria-checked') !== 'false') throw new Error('Consent must start off.');
        if (!dialog.querySelector('.cwi-preview').textContent.includes('Arrêt à l’étape 2.')) throw new Error('Preview did not expose the consent stop.');
        await click(dialog, '[role="switch"]', 'Autoriser les appels payants des clients locaux');
        await click(dialog, 'button', 'Créer la combinaison');
        return actions;
      })()`);
      const saved = await eventually(async () => (await combos()).find(combo => combo.id === comboId), "saved Combo " + comboId);
      deepStrictEqual(saved.targets.map(target => [target.provider, target.model, target.metered === true]),
        ordered.map(provider => ["fixture-" + provider, provider.startsWith("anthropic") ? "claude-fixture" : "gpt-fixture", guided && provider.endsWith("-apikey")]));
      ok(saved.quotaOnlyFallback && saved.allowMeteredTargets);
      console.log(JSON.stringify({ combo: id, setup: guided ? "preset" : "manual", actions, elapsedMs: Math.round(performance.now() - elapsed) }));
    }
    const preview = await evaluate<{ labels: string[]; list: string[]; focusStayed: boolean; modelStop: boolean }>(`(async () => {
      const wait = async (probe, label) => {
        for (let i = 0; i < 200; i++) { const value = probe(); if (value) return value; await new Promise(r => setTimeout(r, 25)); }
        throw new Error('Missing ' + label + ' for ' + ${JSON.stringify(id)});
      };
      const detail = await wait(() => {
        const title = document.querySelector('.combos-workspace-detail-title');
        if (!document.querySelector('dialog[open]') && title?.textContent === ${JSON.stringify("combo/" + id)}) {
          return title.closest('.combos-workspace-detail');
        }
      }, 'the saved combo detail');
      const entries = () => [...detail.querySelectorAll('.cwi-target-entry')];
      const box = await wait(() => detail.querySelector('.cwi-preview'), 'the fallback preview');
      const labels = [...box.querySelectorAll('li code')].map(node => node.textContent);
      const lock = [...detail.querySelectorAll('[role="switch"]')].find(el => el.textContent.trim() === 'Garder le même modèle lors de la bascule');
      if (lock?.getAttribute('aria-checked') !== 'false') throw new Error('The saved model lock must start off.');
      lock.click();
      const modelStop = await wait(() => box.textContent.includes('Modèle différent avec le verrou activé'), 'the model lock stop');
      lock.click();
      await wait(() => lock.getAttribute('aria-checked') === 'false', 'the unlocked combo');
      const moveDown = entries()[0].querySelector('[data-cwi-move="down"]');
      moveDown.focus();
      moveDown.click();
      await wait(() => entries()[1].contains(document.activeElement), 'focus on the reordered row');
      const focusStayed = entries()[1].contains(document.activeElement);
      const list = entries().map(entry => entry.querySelector('[role=combobox]').dataset.value);
      entries()[1].querySelector('[data-cwi-move="up"]').click();
      return { labels, list, focusStayed, modelStop };
    })()`);
    deepStrictEqual(preview.list, [ordered[1], ordered[0], ...ordered.slice(2)].map(provider => "fixture-" + provider));
    deepStrictEqual(preview.labels, ordered.map(provider => provider.startsWith("anthropic") ? "claude-fixture" : "gpt-fixture"));
    ok(preview.focusStayed && preview.modelStop);
    console.log(JSON.stringify({ combo: id, previewSteps: preview.labels.length, reorderFocusVerified: true, modelStop: true }));
  }
  const screenshot = process.argv[2];
  if (screenshot) {
    const consent = "[...document.querySelectorAll('[role=switch]')].find(el => el.textContent.trim() === 'Autoriser les appels payants des clients locaux')";
    await evaluate(consent + ".click()");
    await eventually(() => evaluate<boolean>("document.querySelector('.cwi-preview').textContent.includes('Arrêt à l’étape 2.')"), "the consent stop screenshot");
    await evaluate("document.querySelector('.cwi-preview').scrollIntoView({ block: 'center', behavior: 'instant' })");
    const image = await cdp<{ data: string }>("Page.captureScreenshot", { format: "png" });
    await writeFile(screenshot, Buffer.from(image.data, "base64"));
  }

  async function measure(wire: "responses" | "messages", combo: string, first: "openai" | "anthropic", scenario: string,
    status: number, expected: readonly string[]): Promise<void> {
    const headers = { "content-type": "application/json" };
    const reset = await request(upstream + "/scenario", { method: "POST", headers, body: JSON.stringify({ scenario, first }) });
    deepStrictEqual(reset.status, 204);
    const payload = wire === "responses" ? { input: "Fixture", max_output_tokens: 32 }
      : { messages: [{ role: "user", content: "Fixture" }], max_tokens: 32 };
    const started = performance.now();
    const response = await request(proxy + "/v1/" + wire, { method: "POST", headers,
      body: JSON.stringify({ model: "combo/" + combo, stream: false, ...payload }) });
    const body = await response.text();
    const attempts = await (await request(upstream + "/attempts")).json();
    const elapsedMs = Math.round(performance.now() - started);
    deepStrictEqual(attempts, expected, wire + " " + scenario);
    deepStrictEqual(response.status, status, wire + " " + scenario + ": " + body);
    if (status === 200) ok(body.includes("Fallback fixture completed."));
    console.log(JSON.stringify({ wire, combo, scenario, status, attempts, elapsedMs }));
  }

  for (const [wire, first, id, order] of [
    ["responses", "openai", "openai-first", openai], ["messages", "anthropic", "claude-first", claude],
  ] as const) {
    await measure(wire, id, first, "success", 200, order.slice(0, 1));
    await measure(wire, id, first, "subscription-exhausted", 200, order.slice(0, 2));
    await measure(wire, id, first, "switch-provider", 200, order.slice(0, 3));
    await measure(wire, id, first, "last-key", 200, order);
    await measure(wire, id, first, "all-exhausted", wire === "responses" ? 400 : 429, order);
    await measure(wire, id, first, "transient", 429, order.slice(0, 1));
  }
  await measure("responses", "baseline", "openai", "transient", 200, openai.slice(0, 2));
} finally {
  socket?.close();
  browser.kill("SIGTERM");
  await browser.exited;
  await rm(home, { recursive: true, force: true });
}
