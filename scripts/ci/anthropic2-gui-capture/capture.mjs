#!/usr/bin/env node
// Renders the real OpenCodex dashboard against synthetic anthropic/anthropic2 state and
// captures PNGs for the PR description. Runs under Node (Playwright); the proxy runs under
// the repository's runtime Bun. Fails non-zero when any required selector is missing.
//
// Env (all required unless noted):
//   REPO_ROOT  checkout root (src/cli/index.ts, gui/dist)
//   PW_DIR     directory whose node_modules holds the pinned playwright package
//   OUT_DIR    output directory (PNGs, manifest.json, logs/)
//   BUN_BIN    absolute path of the runtime bun
//   REAL_HOME  (optional) runner home, protected by OCX_TEST_HOME_GUARD
//   HEAD_SHA   (optional) recorded in manifest.json
//   PORT_POPULATED / PORT_EMPTY (optional) loopback ports, default 18431 / 18432
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ACCOUNT_IDS, ALIASES, TEXT, authStore, configFor, quotaCache } from "./seed.mjs";

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}
const REPO_ROOT = need("REPO_ROOT");
const PW_DIR = need("PW_DIR");
const OUT_DIR = need("OUT_DIR");
const BUN_BIN = need("BUN_BIN");
const HEAD_SHA = process.env.HEAD_SHA ?? "unknown";
const PORTS = {
  populated: Number(process.env.PORT_POPULATED ?? 18431),
  empty: Number(process.env.PORT_EMPTY ?? 18432),
};
const STARTUP_TIMEOUT_MS = 120_000;
const SELECTOR_TIMEOUT_MS = 45_000;
const GREEN_MARK = "/provider-icons/claude-green.svg";
const COLOR_MARK = "/provider-icons/claude-color.svg";

// Resolve playwright from PW_DIR/node_modules; the script itself lives in the checkout.
const { chromium } = createRequire(join(PW_DIR, "resolve-anchor.cjs"))("playwright");

const LOG_DIR = join(OUT_DIR, "logs");
mkdirSync(LOG_DIR, { recursive: true });
if (!existsSync(join(REPO_ROOT, "gui", "dist", "index.html"))) {
  throw new Error("gui/dist/index.html is missing; run bun run build:gui first");
}

const manifest = {
  headSha: HEAD_SHA,
  viewport: "1440x900",
  theme: "light",
  captures: [],
  warnings: [],
  failures: [],
  checks: {},
};

// ---------- proxy lifecycle ----------

const ISOLATED_DIRS = ["HOME", "OPENCODEX_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "PATH", "OCX_OWNER_REGISTRY_DIR"];

/** Mirrors the isolated env of tests/gui/gui-pair-http.test.ts:39-48, plus CLAUDE_CONFIG_DIR. */
function isolatedEnv(root) {
  const dir = name => join(root, name);
  const env = {
    HOME: dir("home"), USERPROFILE: dir("home"), OPENCODEX_HOME: dir("ocx"), CODEX_HOME: dir("codex"),
    CLAUDE_CONFIG_DIR: dir("claude"),
    XDG_CONFIG_HOME: dir("xdg-config"), XDG_CACHE_HOME: dir("xdg-cache"), XDG_DATA_HOME: dir("xdg-data"),
    XDG_STATE_HOME: dir("xdg-state"), XDG_RUNTIME_DIR: dir("xdg-runtime"),
    TMPDIR: dir("tmp"), TMP: dir("tmp"), TEMP: dir("tmp"),
    // Empty PATH: no gh, codex or claude binary can be reached from the proxy.
    PATH: dir("empty-bin"),
    OCX_OWNER_REGISTRY_DIR: dir("owner-registry"), NO_PROXY: "127.0.0.1,localhost",
    OCX_TEST_HOME_GUARD: "1", OCX_DISABLE_UPDATE_CHECK: "1", OPENCODEX_KIRO_MODEL_DISCOVERY: "0", CODEX_CI: "1",
    LANG: "C.UTF-8", TZ: "UTC",
  };
  if (process.env.REAL_HOME) env.OCX_REAL_HOME = process.env.REAL_HOME;
  for (const name of ISOLATED_DIRS) mkdirSync(env[name], { recursive: true, mode: 0o700 });
  return env;
}

function seedHome(env, scenario, port) {
  const now = Date.now();
  const write = (file, value) => writeFileSync(join(env.OPENCODEX_HOME, file), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  write("config.json", configFor(scenario, port));
  write("auth.json", authStore(scenario, now));
  write("provider-account-quota-cache.json", quotaCache(scenario, now));
}

function printLog(path, lines = 250) {
  if (!existsSync(path)) return;
  const all = readFileSync(path, "utf8").split("\n");
  console.log(`::group::${path} (last ${lines} lines)`);
  console.log(all.slice(-lines).join("\n"));
  console.log("::endgroup::");
}

async function waitReady(child, origin, port) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let last = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`proxy exited during startup (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    try {
      const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(3_000) });
      const body = await health.json().catch(() => null);
      if (health.status === 200 && body?.service === "opencodex" && body?.port === port) {
        const ready = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(3_000) });
        await ready.body?.cancel();
        if (ready.status === 200) {
          if (body.pid !== child.pid) manifest.warnings.push({ check: "healthz.pid", note: "pid differs from the spawned child" });
          return;
        }
        last = `readyz ${ready.status}`;
      } else {
        last = `healthz ${health.status}`;
      }
    } catch (error) {
      last = error?.cause?.code ?? error?.name ?? "fetch error";
    }
    await sleep(500);
  }
  throw new Error(`proxy not ready within ${STARTUP_TIMEOUT_MS}ms (last: ${last})`);
}

async function startProxy(scenario) {
  const port = PORTS[scenario];
  const origin = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), `ocx-gui-${scenario}-`));
  const env = isolatedEnv(root);
  seedHome(env, scenario, port);
  const logPath = join(LOG_DIR, `${scenario}-proxy.log`);
  const fd = openSync(logPath, "a");
  // Same entry point as Dockerfile:105 and tests/gui/gui-pair-http.test.ts:73.
  const child = spawn(BUN_BIN, [join(REPO_ROOT, "src", "cli", "index.ts"), "start", "--port", String(port)], {
    cwd: root, env, stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  console.log(`[${scenario}] proxy pid ${child.pid} on ${origin} (home ${root})`);
  try {
    await waitReady(child, origin, port);
  } catch (error) {
    printLog(logPath);
    child.kill("SIGKILL");
    throw error;
  }
  return { scenario, port, origin, root, env, child, logPath };
}

async function stopProxy(proxy) {
  const { child } = proxy;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  const result = await Promise.race([exited.then(() => "exited"), sleep(15_000).then(() => "timeout")]);
  if (result === "timeout") {
    manifest.warnings.push({ check: `${proxy.scenario}.stop`, note: "SIGTERM timed out; sent SIGKILL" });
    child.kill("SIGKILL");
    await exited;
  }
}

// ---------- management API preflight (fails before any screenshot if the seed was rejected) ----------

async function sessionToken(origin) {
  // Loopback bootstrap: src/server/index/serve-options.ts:1851 -> gui-session.ts:171 -> gui-static.ts:107.
  const response = await fetch(`${origin}/opencodex-session`, { headers: { Origin: origin }, redirect: "error" });
  if (response.status !== 200) throw new Error(`session bootstrap HTTP ${response.status}`);
  const html = await response.text();
  const token = html.match(/<meta name="opencodex-session-token" content="([^"]+)">/)?.[1];
  if (!token?.startsWith("ocx_session_")) throw new Error("session bootstrap carried no ocx_session_ token");
  return token;
}

async function api(origin, token, path) {
  // Header contract from gui/src/api.ts:225-228 (GET needs no CSRF token).
  const response = await fetch(`${origin}${path}`, {
    headers: { Origin: origin, "X-OpenCodex-API-Key": token, "X-OpenCodex-GUI-Origin": origin },
    redirect: "error",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  try { return JSON.parse(text); } catch { throw new Error(`${path} returned non-JSON`); }
}

function accountIds(body) {
  return Array.isArray(body?.accounts) ? body.accounts.map(account => account?.id).sort() : null;
}

async function preflight(proxy) {
  const token = await sessionToken(proxy.origin);
  const a = await api(proxy.origin, token, "/api/oauth/accounts?provider=anthropic");
  const expectSame = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) {
      throw new Error(`preflight ${label}: expected ${JSON.stringify([...want].sort())}, got ${JSON.stringify(got)}`);
    }
  };
  expectSame("anthropic accounts", accountIds(a), ACCOUNT_IDS.anthropic);
  if (proxy.scenario === "populated") {
    const b = await api(proxy.origin, token, "/api/oauth/accounts?provider=anthropic2");
    expectSame("anthropic2 accounts", accountIds(b), ACCOUNT_IDS.anthropic2);
    const sidecar = await api(proxy.origin, token, "/api/sidecar-settings");
    for (const key of ["webSearch", "vision"]) {
      if (sidecar?.[key]?.backend !== "anthropic" || sidecar?.[key]?.anthropicInstance !== "anthropic2") {
        throw new Error(`preflight sidecar.${key}: expected backend anthropic + anthropicInstance anthropic2`);
      }
    }
    manifest.checks.sidecarPool = {
      webSearch: sidecar.webSearch.anthropicPool ?? null,
      vision: sidecar.vision.anthropicPool ?? null,
    };
  } else {
    // An absent account set may be answered with an error status; the UI capture is the evidence.
    try {
      const b = await api(proxy.origin, token, "/api/oauth/accounts?provider=anthropic2");
      expectSame("anthropic2 accounts (empty pool)", accountIds(b) ?? [], []);
    } catch (error) {
      if (String(error?.message).startsWith("preflight")) throw error;
      manifest.warnings.push({ check: "empty.anthropic2Accounts", note: String(error?.message ?? error) });
    }
  }
  manifest.checks[`${proxy.scenario}.preflight`] = "ok";
}

/** A quota or refresh call that reached Anthropic with a fake token could flip accounts to reauth. */
function assertAccountsHealthy(proxy) {
  const store = JSON.parse(readFileSync(join(proxy.env.OPENCODEX_HOME, "auth.json"), "utf8"));
  const flagged = [];
  for (const [provider, set] of Object.entries(store)) {
    for (const account of set?.accounts ?? []) if (account?.needsReauth) flagged.push(`${provider}/${account.id}`);
  }
  manifest.checks[`${proxy.scenario}.needsReauthAfterCapture`] = flagged;
  if (flagged.length) throw new Error(`accounts flipped to needsReauth during capture: ${flagged.join(", ")}`);
}

// ---------- browser helpers ----------

async function newPage(browser, lang) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: lang === "ko" ? "ko-KR" : "en-US",
    colorScheme: "light",
    reducedMotion: "reduce",
    timezoneId: "UTC",
  });
  // Keys from gui/src/App.tsx:64 (ocx-theme) and gui/src/i18n/shared.ts:20 (ocx-lang).
  await context.addInitScript(value => {
    try {
      localStorage.setItem("ocx-theme", "light");
      localStorage.setItem("ocx-lang", value);
    } catch { /* storage unavailable: locale/colorScheme above still apply */ }
  }, lang);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300)); });
  page.on("pageerror", error => consoleErrors.push(`pageerror: ${String(error?.message ?? error).slice(0, 300)}`));
  return { context, page, consoleErrors };
}

async function visible(locator, what) {
  try {
    await locator.first().waitFor({ state: "visible", timeout: SELECTOR_TIMEOUT_MS });
  } catch {
    throw new Error(`selector missing: ${what}`);
  }
  return locator.first();
}

async function waitCount(locator, expected, what) {
  const deadline = Date.now() + SELECTOR_TIMEOUT_MS;
  let seen = -1;
  while (Date.now() < deadline) {
    seen = await locator.count();
    if (seen === expected) return;
    await sleep(250);
  }
  throw new Error(`expected ${expected} x ${what}, saw ${seen}`);
}

async function settle(page, ms = 1_200) {
  // The dashboard polls, so networkidle may never arrive; it is a best-effort wait.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(ms);
}

async function save(target, file, options = {}) {
  const path = join(OUT_DIR, file);
  await target.screenshot({ path, animations: "disabled", caret: "hide", ...options });
  const bytes = readFileSync(path);
  return { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function capture(browser, proxy, spec) {
  const { context, page, consoleErrors } = await newPage(browser, spec.lang);
  try {
    await page.goto(`${proxy.origin}/#${spec.hash}`, { waitUntil: "load", timeout: 60_000 });
    const files = await spec.run(page);
    for (const file of files) {
      manifest.captures.push({ ...file, capture: spec.name, scenario: proxy.scenario, lang: spec.lang, hash: `#${spec.hash}` });
    }
    console.log(`ok   ${spec.name}: ${files.map(file => file.file).join(", ")}`);
  } catch (error) {
    const message = String(error?.message ?? error);
    await page.screenshot({ path: join(OUT_DIR, `FAILED-${spec.name}.png`), fullPage: true }).catch(() => {});
    const entry = { capture: spec.name, error: message, consoleErrors: consoleErrors.slice(0, 20) };
    (spec.soft ? manifest.warnings : manifest.failures).push(entry);
    console.log(`::${spec.soft ? "warning" : "error"}::${spec.name}: ${message}`);
  } finally {
    if (consoleErrors.length) writeFileSync(join(LOG_DIR, `${spec.name}.console.txt`), consoleErrors.join("\n") + "\n");
    await context.close();
  }
}

// ---------- capture specs ----------

const railRow = (page, title) => page.locator(`button.providers-workspace-rail-row[title="${title}"]`);

async function assertImageLoaded(locator, what) {
  const loaded = await locator.evaluate(img => img.complete && img.naturalWidth > 0);
  if (!loaded) throw new Error(`${what} did not load`);
}

async function openPool2Accounts(page, T, expectedAccounts) {
  await visible(page.locator("h2.pws-detail-title", { hasText: T.b }), `detail title "${T.b}"`);
  await visible(page.locator('[role="tab"][aria-selected="true"]', { hasText: T.accountsTab }), `selected "${T.accountsTab}" tab`);
  await visible(page.locator("section.pwi-auth-section"), "accounts section (section.pwi-auth-section)");
  await waitCount(page.locator("ul.pwi-auth-list > li.pwi-auth-acct"), expectedAccounts, "Pool 2 account rows (li.pwi-auth-acct)");
}

const POPULATED_SPECS = [
  {
    name: "01-providers-rail-en",
    lang: "en",
    hash: "providers",
    async run(page) {
      const T = TEXT.en;
      const rowA = await visible(railRow(page, T.a), `rail row "${T.a}"`);
      const rowB = await visible(railRow(page, T.b), `rail row "${T.b}"`);
      await assertImageLoaded(await visible(rowB.locator(`img[src="${GREEN_MARK}"]`), "green mark in the Pool 2 rail row"), "claude-green.svg");
      await assertImageLoaded(await visible(rowA.locator(`img[src="${COLOR_MARK}"]`), "colour mark in the Anthropic rail row"), "claude-color.svg");
      await settle(page);
      return [
        await save(page, "01-providers-rail-en.png"),
        await save(page.locator("aside.pws-rail"), "01b-providers-rail-crop-en.png"),
      ];
    },
  },
  {
    name: "01c-dashboard-providers-en",
    lang: "en",
    hash: "dashboard/providers",
    soft: true,
    async run(page) {
      await visible(page.getByText(TEXT.en.b, { exact: true }), `"${TEXT.en.b}" on the dashboard Providers section`);
      await settle(page);
      return [await save(page, "01c-dashboard-providers-en.png", { fullPage: true })];
    },
  },
  {
    name: "02-pool2-accounts-en",
    lang: "en",
    hash: "providers?provider=anthropic2&tab=accounts",
    async run(page) {
      const T = TEXT.en;
      await openPool2Accounts(page, T, 2);
      for (const alias of ALIASES.anthropic2) {
        await visible(page.locator(".pwi-auth-row-label", { hasText: alias }), `account row "${alias}"`);
      }
      await visible(page.locator(`button.toggle[aria-label="${T.poolToggle}"]`), "Pool 2 account-pool toggle");
      await settle(page);
      return [
        await save(page, "02-pool2-accounts-en.png"),
        await save(page, "02b-pool2-accounts-full-en.png", { fullPage: true }),
        await save(page.locator("section.pwi-auth-section").first(), "02c-pool2-accounts-panel-en.png"),
      ];
    },
  },
  {
    name: "02d-pool1-accounts-en",
    lang: "en",
    hash: "providers?provider=anthropic&tab=accounts",
    soft: true,
    async run(page) {
      await visible(page.locator("h2.pws-detail-title", { hasText: TEXT.en.a }), "Anthropic detail title");
      await waitCount(page.locator("ul.pwi-auth-list > li.pwi-auth-acct"), 2, "Anthropic account rows");
      await settle(page);
      return [await save(page, "02d-pool1-accounts-en.png")];
    },
  },
  {
    name: "03-models-anthropic2-en",
    lang: "en",
    hash: "models",
    soft: true,
    async run(page) {
      const card = slug => page.locator(".models-provider-card").filter({
        has: page.locator(".models-provider-head .font-semibold", { hasText: new RegExp(`^${slug}$`) }),
      });
      await visible(card("anthropic2"), "anthropic2 group on the Models page");
      // Groups start collapsed (gui/src/pages/Models.tsx:892); expand both Anthropic groups.
      for (const slug of ["anthropic", "anthropic2"]) {
        const toggle = card(slug).locator(".models-provider-toggle").first();
        if (await toggle.count() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
      }
      const target = card("anthropic2").first();
      await target.scrollIntoViewIfNeeded();
      await settle(page);
      return [
        await save(page, "03-models-anthropic2-en.png"),
        await save(target, "03b-models-anthropic2-card-en.png"),
      ];
    },
  },
  {
    name: "05-sidecar-pool-en",
    lang: "en",
    hash: "dashboard",
    async run(page) {
      const T = TEXT.en;
      const grid = await visible(page.locator(".dash-sidecar-grid"), "sidecar cards (.dash-sidecar-grid)");
      const triggers = page.locator(`button[aria-haspopup="listbox"][aria-label="${T.pool}"]`);
      await waitCount(triggers, 2, `"${T.pool}" selects (web search + vision)`);
      for (let index = 0; index < 2; index++) {
        const label = (await triggers.nth(index).innerText()).trim();
        if (!label.includes(T.b)) throw new Error(`Pool select ${index} shows "${label}", expected "${T.b}"`);
      }
      await grid.scrollIntoViewIfNeeded();
      await settle(page);
      const files = [
        await save(grid, "05-sidecar-pool-cards-en.png"),
        await save(page, "05b-sidecar-pool-viewport-en.png"),
      ];
      // Opening the menu changes nothing; only choosing an option saves.
      await triggers.first().click();
      await visible(page.locator(`[role="listbox"][aria-label="${T.pool}"]`), "open Pool menu");
      await page.waitForTimeout(300);
      files.push(await save(page, "05c-sidecar-pool-menu-en.png"));
      await page.keyboard.press("Escape");
      return files;
    },
  },
  {
    name: "06-pool2-accounts-ko",
    lang: "ko",
    hash: "providers?provider=anthropic2&tab=accounts",
    async run(page) {
      const T = TEXT.ko;
      await visible(railRow(page, T.b), `rail row "${T.b}"`);
      await openPool2Accounts(page, T, 2);
      await visible(page.locator(`button.toggle[aria-label="${T.poolToggle}"]`), "Pool 2 account-pool toggle (ko)");
      await settle(page);
      return [await save(page, "06-pool2-accounts-ko.png")];
    },
  },
];

const EMPTY_SPECS = [
  {
    name: "04-pool2-empty-en",
    lang: "en",
    hash: "providers?provider=anthropic2&tab=accounts",
    async run(page) {
      const T = TEXT.en;
      await visible(railRow(page, T.b), `rail row "${T.b}"`);
      await openPool2Accounts(page, T, 0);
      await settle(page, 2_000);
      await waitCount(page.locator("li.pwi-auth-acct"), 0, "account rows after settle");
      manifest.checks.emptyState = await page.locator(".pwi-auth-state--empty").count() ? "noAccounts" : "loginCta";
      return [
        await save(page, "04-pool2-empty-en.png"),
        await save(page.locator("section.pwi-auth-section").first(), "04b-pool2-empty-panel-en.png"),
      ];
    },
  },
];

// ---------- main ----------

function writeManifest() {
  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const lines = [
    `### anthropic2 dashboard captures (${HEAD_SHA.slice(0, 10)})`,
    "",
    "| file | scenario | lang | route |",
    "| --- | --- | --- | --- |",
    ...manifest.captures.map(c => `| ${c.file} | ${c.scenario} | ${c.lang} | ${c.hash} |`),
    "",
    `failures: ${manifest.failures.length}, warnings: ${manifest.warnings.length}`,
  ];
  appendFileSync(summary, lines.join("\n") + "\n");
}

const browser = await chromium.launch();
try {
  for (const [scenario, specs] of [["populated", POPULATED_SPECS], ["empty", EMPTY_SPECS]]) {
    let proxy;
    try {
      proxy = await startProxy(scenario);
      await preflight(proxy);
      for (const spec of specs) await capture(browser, proxy, spec);
      assertAccountsHealthy(proxy);
    } catch (error) {
      manifest.failures.push({ capture: `${scenario}:setup`, error: String(error?.message ?? error) });
      console.log(`::error::${scenario}: ${error?.message ?? error}`);
    } finally {
      if (proxy) await stopProxy(proxy);
    }
  }
} finally {
  await browser.close();
  writeManifest();
}

if (manifest.failures.length) {
  for (const scenario of Object.keys(PORTS)) printLog(join(LOG_DIR, `${scenario}-proxy.log`));
  console.log(`${manifest.failures.length} required capture(s) failed; see manifest.json and FAILED-*.png`);
  process.exit(1);
}
console.log(`${manifest.captures.length} screenshots written to ${OUT_DIR}`);
