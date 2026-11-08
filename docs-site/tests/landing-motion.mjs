// Run against the docs dev server with PLAYWRIGHT_CORE pointing to an installed
// playwright-core entry and CHROME_PATH pointing to a Chromium executable.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const url = process.env.DOCS_URL ?? 'http://127.0.0.1:4317/';
const pause = (page, ms = 150) => page.waitForTimeout(ms);
const open = async (page, waitUntil = 'load') => {
  // Keep the counter test deterministic when GitHub is unavailable at build time.
  await page.route(url, async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const landing = html.replace(/<a class="lp-github-cta"[\s\S]*?<\/a>/, (link) => {
      const withoutCount = link.replace(/<span data-gh-stars="\d+">[^<]*<\/span>/, '');
      return withoutCount.replace('</a>', '<span data-gh-stars="18300">18.3k</span></a>');
    });
    const body = landing.replace(/<a class="github-link[\s\S]*?<\/a>/, (link) => {
      const withoutCount = link.replace(/<span class="gh-count[^>]*data-gh-stars="\d+"[^>]*>[^<]*<\/span>/, '');
      return withoutCount.replace('</a>', '<span class="gh-count" data-gh-stars="18300">18.3k</span></a>');
    });
    await route.fulfill({ response, body });
  });
  await page.goto(url, { waitUntil });
};
const readMotion = (page) => page.evaluate(() => {
  const hero = document.querySelector('.lp-hero-field');
  const button = document.querySelector('.lp-btn-primary');
  return { px: hero.style.getPropertyValue('--px'), sy: hero.style.getPropertyValue('--sy'),
    mx: button.style.getPropertyValue('--mgx'), my: button.style.getPropertyValue('--mgy') };
});
const move = async (page) => {
  await page.locator('.lp-hero-field').dispatchEvent('pointermove', { clientX: 1100, clientY: 450 });
  await page.locator('.lp-btn-primary').dispatchEvent('pointermove', { clientX: 1100, clientY: 450 });
  await pause(page);
};
const assertStillPoster = async (page) => {
  const poster = page.locator('.lp-scrub-poster');
  await poster.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const image = document.querySelector('.lp-scrub-poster');
    return image.complete && image.naturalWidth > 0;
  });
  await poster.evaluate(el => el.decode());
  assert.equal(await poster.isVisible(), true, 'poster is visible');
  const src = await poster.evaluate(el => el.currentSrc);
  const response = await page.request.get(src);
  assert.equal(response.ok(), true, 'poster asset is served');
  const bytes = await response.body();
  const metadata = await sharp(bytes, { animated: true }).metadata();
  assert.equal(metadata.pages ?? 1, 1, 'served poster has exactly one frame');
  const base = await page.locator('.lp-scrub-canvas').getAttribute('data-base');
  const firstFrame = await page.request.get(new URL(`${base}demo-frames/001.webp`, url).href);
  assert.equal(firstFrame.ok(), true, 'first scrub frame is served');
  assert.deepEqual(bytes, await firstFrame.body(), 'poster is the first scrub frame');
};
try {
  const headerPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
  await open(headerPage, 'domcontentloaded');
  await headerPage.waitForFunction(() => document.querySelector('.github-link [data-gh-stars]')?.style.filter);
  await headerPage.emulateMedia({ reducedMotion: 'reduce' });
  await pause(headerPage);
  const headerCount = headerPage.locator('.github-link [data-gh-stars]');
  assert.equal(await headerCount.textContent(), '18.3k', 'header counter finishes immediately');
  assert.deepEqual(await headerCount.evaluate(el => [el.style.filter, el.style.transform]), ['', '']);
  await pause(headerPage, 400);
  assert.equal(await headerCount.textContent(), '18.3k', 'header counter stays final');
  await headerPage.close();

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
  await open(page);
  await move(page);
  const moving = await readMotion(page);
  assert.notEqual(Number(moving.px), 0, 'parallax starts');
  assert.notEqual(parseFloat(moving.mx), 0, 'magnet starts');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pause(page);
  assert.equal(await page.locator('.lp-drum-static').isVisible(), true, 'static headline is visible');
  const reset = await readMotion(page);
  assert.ok(!parseFloat(reset.px) && !parseFloat(reset.sy) && !parseFloat(reset.mx) && !parseFloat(reset.my), `motion resets: ${JSON.stringify(reset)}`);
  await move(page);
  assert.deepEqual(await readMotion(page), reset, 'pointer cannot restart reduced motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await move(page);
  assert.notEqual(parseFloat((await readMotion(page)).mx), 0, 'motion resumes on new input');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const pendingStars = page.locator('.lp-github-cta [data-gh-stars]');
  await pendingStars.scrollIntoViewIfNeeded();
  await pause(page, 400);
  assert.equal(await pendingStars.textContent(), '18.3k', 'counter cannot start after reduction');

  await page.close();
  const counterPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
  await open(counterPage);
  const stars = counterPage.locator('.lp-github-cta [data-gh-stars]');
  assert.equal(await stars.count(), 1, 'star fixture is present');
  const final = await stars.textContent();
  await stars.scrollIntoViewIfNeeded();
  await counterPage.waitForFunction((expected) => {
    const el = document.querySelector('.lp-github-cta [data-gh-stars]');
    return el && el.textContent !== expected;
  }, final, { timeout: 2000 });
  await counterPage.emulateMedia({ reducedMotion: 'reduce' });
  await pause(counterPage);
  assert.equal(await stars.textContent(), final, 'counter finishes immediately');
  await pause(counterPage, 400);
  assert.equal(await stars.textContent(), final, 'counter stays final');
  await counterPage.close();

  const scrubPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
  await open(scrubPage);
  await scrubPage.locator('.lp-scene-scrub').scrollIntoViewIfNeeded();
  await scrubPage.waitForFunction(() => getComputedStyle(document.querySelector('.lp-scrub-canvas')).display !== 'none');
  const initialFrame = await scrubPage.locator('.lp-scrub-canvas').evaluate(el => el.toDataURL());
  await scrubPage.locator('.lp-scene-scrub').evaluate(el => {
    const top = el.getBoundingClientRect().top + scrollY;
    scrollTo(0, top + (el.offsetHeight - innerHeight) * 0.8);
  });
  await scrubPage.waitForFunction(previous => document.querySelector('.lp-scrub-canvas').toDataURL() !== previous, initialFrame);
  await scrubPage.emulateMedia({ reducedMotion: 'reduce' });
  await pause(scrubPage, 500);
  assert.equal(await scrubPage.locator('.lp-scrub-canvas').isVisible(), false, 'scrub canvas stops');
  await assertStillPoster(scrubPage);
  await scrubPage.evaluate(() => scrollBy(0, 300));
  await pause(scrubPage, 300);
  assert.equal(await scrubPage.locator('.lp-scrub-canvas').isVisible(), false, 'scroll cannot restart scrub');
  await scrubPage.close();

  const reducedDesktop = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await open(reducedDesktop);
  await assertStillPoster(reducedDesktop);
  assert.equal(await reducedDesktop.locator('.lp-scrub-canvas').isVisible(), false, 'initial reduction leaves canvas hidden');
  const desktopBefore = await readMotion(reducedDesktop);
  await move(reducedDesktop);
  assert.deepEqual(await readMotion(reducedDesktop), desktopBefore, 'initial reduction blocks fine-pointer motion');
  const staticStars = reducedDesktop.locator('.lp-github-cta [data-gh-stars]');
  await staticStars.scrollIntoViewIfNeeded();
  await pause(reducedDesktop, 400);
  assert.equal(await staticStars.textContent(), '18.3k', 'initial reduction blocks counter');
  await reducedDesktop.close();

  const reduced = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await open(reduced);
  await assertStillPoster(reduced);
  const before = await readMotion(reduced);
  await move(reduced);
  assert.deepEqual(await readMotion(reduced), before, 'initial reduced preference blocks motion');
  const menu = reduced.locator('.lp-menu-btn');
  await menu.focus();
  await reduced.keyboard.press('Enter');
  assert.equal(await menu.getAttribute('aria-expanded'), 'true');
  await reduced.keyboard.press('Tab');
  assert.equal(await reduced.evaluate(() => document.activeElement?.closest('#lp-menu-panel') !== null), true, 'open menu reachable by keyboard');
  await reduced.keyboard.press('Escape');
  assert.equal(await menu.getAttribute('aria-expanded'), 'false');
  assert.equal(await menu.evaluate(el => document.activeElement === el), true, 'Escape restores focus');
  await reduced.keyboard.press('Tab');
  assert.equal(await reduced.evaluate(() => document.activeElement?.closest('#lp-menu-panel') === null), true, 'closed menu is not tabbable');
  console.log('landing motion and keyboard checks passed');
} finally {
  await browser.close();
}
