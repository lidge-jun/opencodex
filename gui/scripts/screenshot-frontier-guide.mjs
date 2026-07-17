import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = "C:\\Users\\JK\\Desktop\\frontier-guide-2026-07-18";
const BASE = process.env.OCX_GUI_URL || "http://localhost:5173";

try {
  fs.mkdirSync(OUT, { recursive: true });
} catch (err) {
  if (err && typeof err === "object" && "code" in err && err.code !== "EEXIST") throw err;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

async function shot(name) {
  const file = path.join(OUT, name);
  await page.waitForTimeout(600);
  await page.screenshot({ path: file, fullPage: false });
  console.log("wrote", file);
}

await page.goto(`${BASE}/#frontier`, { waitUntil: "networkidle" });
await page.waitForSelector(".frontier-page", { timeout: 15000 });
await page.waitForTimeout(1200);
await shot("01-frontier-overview-scatter.png");

// FrontierCode + All reasoning + By reasoning
await page.getByRole("tab", { name: "FrontierCode", exact: true }).click();
await page.waitForTimeout(400);
await page.getByRole("tab", { name: "All reasoning levels" }).click();
await page.waitForTimeout(200);
await page.getByRole("tab", { name: "By reasoning", exact: true }).click();
await page.waitForTimeout(900);
await shot("02-frontiercode-reasoning-all.png");

// Cost stack on Intelligence Index
await page.getByRole("tab", { name: "All", exact: true }).first().click();
await page.waitForTimeout(200);
await page.getByRole("tab", { name: "AA Intelligence Index", exact: true }).click();
await page.waitForTimeout(300);
await page.getByRole("tab", { name: "Cost stack", exact: true }).click();
await page.waitForTimeout(900);
await shot("03-intelligence-cost-stack.png");

// Security domain / Cybench
await page.getByRole("tab", { name: "Security", exact: true }).click();
await page.waitForTimeout(500);
await page.getByRole("tab", { name: "By score", exact: true }).click();
await page.waitForTimeout(800);
await shot("04-security-cybench.png");

// Coding domain board grid
await page.getByRole("tab", { name: "Coding", exact: true }).click();
await page.waitForTimeout(400);
await page.getByRole("tab", { name: "Scatter", exact: true }).click();
await page.waitForTimeout(700);
await shot("05-coding-domain-scatter.png");

await browser.close();
console.log("done →", OUT);
