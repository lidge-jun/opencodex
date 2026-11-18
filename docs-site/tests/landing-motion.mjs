// Run against the docs dev server with PLAYWRIGHT_CORE pointing to an installed
// playwright-core entry and CHROME_PATH pointing to a Chromium executable.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const url = process.env.DOCS_URL ?? 'http://127.0.0.1:4317/';
const pause = (page, ms = 150) => page.waitForTimeout(ms);
const withHeaderCount = html => html.replace(/<a class="github-link[\s\S]*?<\/a>/, link => {
  const scope = link.match(/<span class="gh-main([^\"]*)"/)?.[1];
  assert.ok(scope?.includes('astro-'), 'header star fixture retains the component scope');
  const withoutCount = link.replace(/<span class="gh-count[^>]*data-gh-stars="\d+"[^>]*>[^<]*<\/span>/, '');
  return withoutCount.replace('</a>', `<span class="gh-count${scope}" data-gh-stars="18300" aria-hidden="true">18.3k</span></a>`);
});
const open = async (page, waitUntil = 'load') => {
  // Keep the counter test deterministic when GitHub is unavailable at build time.
  await page.route(url, async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const landing = html.replace(/<a class="lp-github-cta"[\s\S]*?<\/a>/, (link) => {
      const withoutCount = link.replace(/<span data-gh-stars="\d+">[^<]*<\/span>/, '');
      return withoutCount.replace('</a>', '<span data-gh-stars="18300">18.3k</span></a>');
    });
    const body = withHeaderCount(landing);
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
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.lp-scrub-poster')).display !== 'none');
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
const assertScrubMoves = async (page) => {
  const canvas = page.locator('.lp-scrub-canvas');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.lp-scrub-canvas')).display !== 'none', null, { timeout: 5000 });
  const section = page.locator('.lp-scene-scrub');
  await section.evaluate(el => scrollTo(0, el.getBoundingClientRect().top + scrollY));
  await page.waitForFunction(async () => {
    const canvas = document.querySelector('.lp-scrub-canvas');
    const image = document.querySelector('.lp-scrub-poster');
    await image.decode();
    const expected = document.createElement('canvas');
    expected.width = canvas.width; expected.height = canvas.height;
    expected.getContext('2d').drawImage(image, 0, 0, expected.width, expected.height);
    return canvas.toDataURL() === expected.toDataURL();
  }, null, { timeout: 5000 });
  const first = await canvas.evaluate(el => el.toDataURL());
  await section.evaluate(el => scrollTo(0, el.getBoundingClientRect().top + scrollY + (el.offsetHeight - innerHeight) * 0.8));
  await page.waitForFunction(previous => document.querySelector('.lp-scrub-canvas').toDataURL() !== previous, first, { timeout: 5000 });
};
try {
  // On docs pages Starlight's fixed menu button must not cover the GitHub link.
  for (const width of [320, 375, 414, 640, 768, 799]) {
    const docsHeader = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
    await docsHeader.route('https://api.github.com/**', route => route.abort());
    const docsUrl = new URL('guides/providers/', url).href;
    await docsHeader.route(docsUrl, async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: withHeaderCount(await response.text()) });
    });
    await docsHeader.goto(docsUrl, { waitUntil: 'load' });
    const github = docsHeader.locator('.github-link');
    const hitTest = await github.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const menu = document.querySelector('starlight-menu-button button').getBoundingClientRect();
      return { receivesPointer: !!hit && el.contains(hit), linkRight: rect.right, menuLeft: menu.left };
    });
    assert.equal(hitTest.receivesPointer, true, `GitHub link receives pointer input at ${width}px`);
    assert.ok(hitTest.linkRight <= hitTest.menuLeft + 1, `GitHub link does not overlap the docs menu at ${width}px`);
    await github.click({ trial: true, timeout: 2000 });
    await docsHeader.close();
  }

  // A short desktop viewport must keep the entire dropdown reachable by keyboard,
  // and reduced motion must also stop the two sliding navigation highlights.
  const shortNav = await browser.newPage({ viewport: { width: 1280, height: 360 }, reducedMotion: 'reduce' });
  await shortNav.route('https://api.github.com/**', route => route.abort());
  await shortNav.goto(new URL('guides/providers/', url).href, { waitUntil: 'load' });
  await shortNav.locator('[aria-controls="nav-drop-2"]').click();
  const referencePanel = shortNav.locator('#nav-drop-2 .nav-panel');
  const referenceLinks = referencePanel.locator('ul a');
  await referenceLinks.first().focus();
  for (let i = 1; i < await referenceLinks.count(); i++) await shortNav.keyboard.press('Tab');
  assert.equal(await referenceLinks.last().evaluate(el => el === document.activeElement), true, 'Tab reaches the last reference link');
  const shortNavState = await referencePanel.evaluate(panel => {
    const link = document.activeElement.getBoundingClientRect();
    const rect = panel.getBoundingClientRect();
    const highlight = panel.querySelector('.nav-hl');
    const topHighlight = document.querySelector('.nav-top-hl');
    const hlRect = highlight.getBoundingClientRect();
    return { bottom: rect.bottom, viewport: innerHeight, overflow: getComputedStyle(panel).overflowY,
      scrollTop: panel.scrollTop, linkTop: link.top, linkBottom: link.bottom, panelTop: rect.top,
      highlightTop: hlRect.top, highlightTransitions: getComputedStyle(highlight).transitionDuration,
      topTransitions: getComputedStyle(topHighlight).transitionDuration };
  });
  assert.ok(shortNavState.bottom <= shortNavState.viewport + 1, `dropdown fits viewport: ${JSON.stringify(shortNavState)}`);
  assert.equal(shortNavState.overflow, 'auto', 'dropdown scrolls when its contents exceed the viewport');
  assert.ok(shortNavState.scrollTop > 0 && shortNavState.linkTop >= shortNavState.panelTop && shortNavState.linkBottom <= shortNavState.bottom,
    `last keyboard-focused link is visible: ${JSON.stringify(shortNavState)}`);
  assert.ok(Math.abs(shortNavState.highlightTop - shortNavState.linkTop) <= 2, `highlight follows the scrolled link: ${JSON.stringify(shortNavState)}`);
  for (const transitions of [shortNavState.highlightTransitions, shortNavState.topTransitions]) {
    assert.ok(transitions.split(',').every(duration => parseFloat(duration) === 0), `reduced-motion highlights do not animate: ${transitions}`);
  }
  await shortNav.close();

  const animatedNav = await browser.newPage({ viewport: { width: 1280, height: 360 }, reducedMotion: 'no-preference' });
  await animatedNav.route('https://api.github.com/**', route => route.abort());
  await animatedNav.goto(new URL('guides/providers/', url).href, { waitUntil: 'load' });
  await animatedNav.locator('[aria-controls="nav-drop-2"]').click();
  const animatedPanel = animatedNav.locator('#nav-drop-2 .nav-panel');
  const animatedLinks = animatedPanel.locator('ul a');
  await animatedLinks.first().focus();
  for (let i = 1; i < await animatedLinks.count(); i++) await animatedNav.keyboard.press('Tab');
  await animatedNav.waitForFunction(() => {
    const panel = document.querySelector('#nav-drop-2 .nav-panel');
    const highlight = panel.querySelector('.nav-hl').getBoundingClientRect();
    const link = document.activeElement.getBoundingClientRect();
    return panel.scrollTop > 0 && Math.abs(highlight.top - link.top) <= 2;
  }, null, { timeout: 3000 });
  await animatedNav.close();

  // The desktop header must contain its controls even when translations are wide.
  // Cover both the landing and docs headers at the nav breakpoint and wide rail cap.
  for (const locale of ['', 'fr/', 'ko/', 'zh-cn/', 'zh-tw/', 'ru/', 'ja/', 'tr/']) {
    for (const path of ['', 'guides/providers/']) {
      for (const width of [1152, 1180, 1280, 1920, 2560]) {
        const navPage = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        await navPage.route('https://api.github.com/**', route => route.abort());
        const navUrl = new URL(`${locale}${path}`, url).href;
        await navPage.route(navUrl, async route => {
          const response = await route.fetch();
          const html = await response.text();
          const body = withHeaderCount(html);
          await route.fulfill({ response, body });
        });
        await navPage.goto(navUrl, { waitUntil: 'load' });
        await navPage.evaluate(() => document.fonts.ready);
        const bounds = await navPage.evaluate(() => {
          const bar = document.querySelector('header.header > .header');
          const barRect = bar.getBoundingClientRect();
          const items = [...bar.children].filter(el => getComputedStyle(el).display !== 'none').map(el => {
            const rect = el.getBoundingClientRect();
            return { name: el.className, left: rect.left - barRect.left, right: rect.right - barRect.right };
          });
          const nav = bar.querySelector('.glass-nav');
          if (nav && getComputedStyle(nav).display !== 'none') {
            const navRect = nav.getBoundingClientRect();
            for (const el of nav.querySelectorAll(':scope > ul > li > .nav-link')) {
              const rect = el.getBoundingClientRect();
              items.push({ name: `nav control ${el.textContent.trim()}`,
                left: rect.left - navRect.left, right: rect.right - navRect.right });
            }
          }
          return items;
        });
        for (const item of bounds) {
          assert.ok(item.left >= -1 && item.right <= 1,
            `${locale || 'en/'}${path} ${width}px: ${item.name} escapes header: ${JSON.stringify(item)}`);
        }
        await navPage.close();
      }
    }
  }

  const switches = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await open(switches);
  await assertStillPoster(switches);
  await switches.emulateMedia({ reducedMotion: 'no-preference' });
  await switches.locator('.lp-scene-scrub').scrollIntoViewIfNeeded();
  await assertScrubMoves(switches);
  await switches.emulateMedia({ reducedMotion: 'reduce' });
  await pause(switches, 250);
  await assertStillPoster(switches);
  await switches.waitForFunction(() => !document.querySelector('.lp-scene-scrub').hasAttribute('data-scrub-active'), null, { timeout: 5000 });
  await switches.emulateMedia({ reducedMotion: 'no-preference' });
  await assertScrubMoves(switches);
  await switches.setViewportSize({ width: 390, height: 844 });
  await assertStillPoster(switches);
  assert.equal(await switches.locator('.lp-scrub-canvas').isVisible(), false, 'mobile hides the canvas');
  await switches.waitForFunction(() => !document.querySelector('.lp-scene-scrub').hasAttribute('data-scrub-active'), null, { timeout: 5000 });
  await switches.setViewportSize({ width: 1280, height: 800 });
  await switches.locator('.lp-scene-scrub').scrollIntoViewIfNeeded();
  await assertScrubMoves(switches);
  await switches.close();

  const mobileFirst = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
  await open(mobileFirst);
  await assertStillPoster(mobileFirst);
  await mobileFirst.setViewportSize({ width: 1280, height: 800 });
  await mobileFirst.locator('.lp-scene-scrub').scrollIntoViewIfNeeded();
  await assertScrubMoves(mobileFirst);
  await mobileFirst.close();

  const noScript = await browser.newPage({ viewport: { width: 1280, height: 800 }, javaScriptEnabled: false });
  await open(noScript);
  await assertStillPoster(noScript);
  assert.ok(await noScript.locator('.lp-scene-scrub').evaluate(el => el.offsetHeight < innerHeight * 2), 'static fallback has no long empty scroll');
  await noScript.close();

  const unsupported = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
  await unsupported.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...args) => args[0] === 'animation-timeline: view()' ? false : supports(...args);
  });
  await open(unsupported);
  await assertStillPoster(unsupported);
  assert.equal(await unsupported.locator('.lp-scrub-canvas').isVisible(), false, 'unsupported timeline keeps the poster');
  assert.ok(await unsupported.locator('.lp-scene-scrub').evaluate(el => el.offsetHeight < innerHeight * 2), 'unsupported timeline has no long empty scroll');
  await unsupported.close();

  const missingFrames = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
  await missingFrames.route('**/demo-frames/*.webp', route => /\/001\.webp$/.test(route.request().url()) ? route.continue() : route.abort());
  await open(missingFrames);
  await assertStillPoster(missingFrames);
  await pause(missingFrames, 500);
  assert.equal(await missingFrames.locator('.lp-scrub-canvas').isVisible(), false, 'missing sequence keeps the poster');
  assert.ok(await missingFrames.locator('.lp-scene-scrub').evaluate(el => el.offsetHeight < innerHeight * 2), 'missing sequence has no long empty scroll');
  await missingFrames.close();

  const cssPage = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await open(cssPage);
  await cssPage.locator('.lp-menu-btn').focus();
  await cssPage.keyboard.press('Enter');
  const summary = cssPage.locator('.lp-menu-group > summary').first();
  await summary.focus();
  await cssPage.keyboard.press('Enter');
  assert.equal(await summary.locator('..').getAttribute('open'), '', 'accordion opens by keyboard');
  assert.equal(await summary.locator('svg').evaluate(el => getComputedStyle(el).transitionDuration), '0s', 'accordion arrow does not animate');
  await cssPage.keyboard.press('Escape');
  const glow = await cssPage.locator('.lp-cell').first().evaluate(el => getComputedStyle(el, '::before').transitionDuration);
  assert.ok(glow.split(',').every(duration => parseFloat(duration) === 0), `card glow does not animate: ${glow}`);
  const card = cssPage.locator('.lp-cell').first();
  const beforeGlow = await card.evaluate(el => getComputedStyle(el, '::before').transform);
  await card.hover();
  assert.equal(await card.evaluate(el => getComputedStyle(el, '::before').transform), beforeGlow, 'card glow does not scale on hover');
  await cssPage.close();
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
