/**
 * Capture screenshots of providers-workspace modals / dialog surfaces.
 * Usage (GUI + proxy running):
 *   node scripts/screenshot-workspace-modals.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const require = createRequire(join(repoRoot, "gui", "package.json"));
const { chromium } = require("playwright");

const BASE = process.env.OCX_GUI_URL || "http://127.0.0.1:5173";
const OUT = process.env.OCX_SHOT_DIR
  || join(repoRoot, "output", "workspace-modals-2026-07-16");

mkdirSync(OUT, { recursive: true });

async function shot(page, name, clip = null) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({
    path,
    fullPage: !clip,
    ...(clip ? { clip } : {}),
  });
  console.log("wrote", path);
}

async function shotModal(page, name) {
  const modal = page.locator(".modal-overlay .modal-card, .modal-overlay [role='dialog'], .modal-card").first();
  await modal.waitFor({ state: "visible", timeout: 8000 });
  await page.waitForTimeout(200);
  const box = await modal.boundingBox();
  if (box) {
    // pad around modal so overlay context is visible
    const pad = 24;
    await page.screenshot({
      path: join(OUT, `${name}.png`),
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: Math.min(box.width + pad * 2, 1400),
        height: Math.min(box.height + pad * 2, 900),
      },
    });
  } else {
    await shot(page, name);
  }
  console.log("wrote", join(OUT, `${name}.png`));
}

async function closeModal(page) {
  // Prefer explicit close control, else Escape
  const close = page.locator(".modal-overlay button").filter({ hasText: /close|cancel|×|back/i }).first();
  if (await close.count() && await close.isVisible().catch(() => false)) {
    // don't click random back; use Escape
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  // click overlay backdrop if still open
  if (await page.locator(".modal-overlay").count()) {
    await page.locator(".modal-overlay").click({ position: { x: 8, y: 8 }, force: true }).catch(() => {});
    await page.waitForTimeout(200);
  }
}

async function openAddModal(page) {
  // Rail "Add" is the stable entry
  const addBtn = page.locator("button.pwi-rail-add-btn, button").filter({ hasText: /^Add$|Add provider|Hinzufügen|添加|추가/i }).first();
  if (await addBtn.count()) {
    await addBtn.click();
  } else {
    // empty-state free tile
    await page.locator("button").filter({ hasText: /free|gratis|免费|무료/i }).first().click();
  }
  await page.locator(".modal-overlay").waitFor({ state: "visible", timeout: 8000 });
  await page.waitForTimeout(300);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);

  console.log("opening", `${BASE}/#providers`);
  await page.goto(`${BASE}/#providers`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // 00 — full overview (context for modal shots)
  await shot(page, "00-providers-overview");

  // 01 — Add provider Free tab (home sheet)
  await openAddModal(page);
  // ensure Free tab
  const freeTab = page.getByRole("tab", { name: /free|gratis|免费|무료/i }).first();
  if (await freeTab.count()) await freeTab.click();
  await page.waitForTimeout(250);
  await shotModal(page, "01-add-provider-free-tab");

  // 02 — Paid tab
  const paidTab = page.getByRole("tab", { name: /paid|kostenpflichtig|付费|유료/i }).first();
  if (await paidTab.count()) {
    await paidTab.click();
    await page.waitForTimeout(250);
    await shotModal(page, "02-add-provider-paid-tab");
  }

  // 03 — Accounts tab
  const accountsTab = page.getByRole("tab", { name: /account|login|konto|账户|계정/i }).first();
  if (await accountsTab.count()) {
    await accountsTab.click();
    await page.waitForTimeout(250);
    await shotModal(page, "03-add-provider-accounts-tab");
  }

  // 04 — Browse free catalog (if button present on free tab)
  if (await freeTab.count()) await freeTab.click();
  await page.waitForTimeout(150);
  const browseFree = page.locator("button").filter({ hasText: /browse|alle|全部|전체|more|weitere/i }).first();
  if (await browseFree.count() && await browseFree.isVisible().catch(() => false)) {
    await browseFree.click();
    await page.waitForTimeout(300);
    await shotModal(page, "04-add-provider-browse-free");
  }

  // 05 — Connect first free preset → setup form (if listed)
  // go back to free home if needed
  const freeHome = page.getByRole("tab", { name: /free|gratis|免费|무료/i }).first();
  if (await freeHome.count()) await freeHome.click();
  await page.waitForTimeout(200);
  const connectBtn = page.locator(".add-prov-row-connect, .modal-card button").filter({ hasText: /connect|verbinden|连接|연결/i }).first();
  if (await connectBtn.count() && await connectBtn.isVisible().catch(() => false)) {
    await connectBtn.click();
    await page.waitForTimeout(400);
    await shotModal(page, "05-add-provider-setup-form");
  }

  // 06 — Custom / not listed path if available from free/paid home
  await closeModal(page);
  await openAddModal(page);
  const custom = page.locator("button, a").filter({ hasText: /custom|not listed|eigen|自定义|사용자/i }).first();
  if (await custom.count() && await custom.isVisible().catch(() => false)) {
    await custom.click();
    await page.waitForTimeout(350);
    await shotModal(page, "06-add-provider-custom");
  }

  await closeModal(page);
  await page.waitForTimeout(300);

  // 07 — Filter popover (workspace chrome, not a true modal but new UI)
  const filterBtn = page.locator("button.pwi-rail-filter-btn, button[aria-label*='ilter'], button[title*='ilter']").first();
  if (await filterBtn.count()) {
    await filterBtn.click();
    await page.waitForTimeout(300);
    await shot(page, "07-rail-filter-menu");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }

  // 08 — Edit JSON full pane (replaced modal)
  const editJson = page.locator("button.pwi-edit-json-btn, button").filter({ hasText: /edit json|json bearbeiten|编辑 json|json 편집/i }).first();
  if (await editJson.count() && await editJson.isVisible().catch(() => false)) {
    await editJson.click();
    await page.waitForTimeout(400);
    await shot(page, "08-edit-json-pane");
    // back
    const back = page.locator("button.pwi-back-overview, button").filter({ hasText: /all providers|alle anbieter|全部|모든/i }).first();
    if (await back.count()) await back.click();
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }

  // 09 — Rate limits section on overview (scroll into view)
  const rate = page.locator("section.pwi-overview-quotas").first();
  if (await rate.count()) {
    await rate.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(200);
    await shot(page, "09-overview-rate-limits");
  } else {
    const rateText = page.getByText(/Rate limits|Ratenlimits|速率限制|속도 제한/i).first();
    if (await rateText.count()) {
      await rateText.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(200);
      await shot(page, "09-overview-rate-limits");
    }
  }

  // 10 — Selected provider detail (for completeness of redesign surfaces)
  const firstRail = page.locator("button.providers-workspace-rail-row").first();
  if (await firstRail.count()) {
    await firstRail.click();
    await page.waitForTimeout(600);
    await shot(page, "10-provider-detail");
  }

  await browser.close();
  console.log("\nAll screenshots in:", OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
