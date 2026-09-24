// npm run check:browser
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const base = new URL('../examples/fishing/dist/', import.meta.url);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const files = { '/': 'index.html', '/demo.js': 'demo.js', '/demo.css': 'demo.css' };
  if (!files[path]) { response.writeHead(404).end(); return; }
  try {
    const data = await readFile(new URL(files[path], base));
    response.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }).end(data);
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1100, height: 800 }, { width: 360, height: 780 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch: viewport.width < 500 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('blob:') ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const original = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = array => { if (array instanceof Uint32Array && array.length === 1) { array[0] = 1500; return array; } return original(array); };
    });
    await page.goto(origin);
    const button = name => page.getByRole('button', { name, exact: true });
    const choose = name => page.getByRole('button', { name: new RegExp(name) }).click();
    async function bounds() {
      assert.deepEqual(await page.evaluate(() => {
        const frame = document.querySelector('.rf-game-frame'), box = frame.getBoundingClientRect(), problems = [];
        if (Math.abs(box.width / box.height - 1.5) > .01) problems.push('Viewport aspect ratio changed');
        if (document.documentElement.scrollWidth > innerWidth) problems.push('Page has horizontal overflow');
        for (const menu of document.querySelectorAll('.rf-frame-menu')) {
          const rect = menu.getBoundingClientRect();
          if (rect.left < box.left || rect.right > box.right || rect.top < box.top || rect.bottom > box.bottom) problems.push('Menu escaped frame');
          if (menu.scrollWidth > menu.clientWidth + 1) problems.push('Menu has horizontal overflow');
        }
        for (const panel of document.querySelectorAll('.fv1-collection-scroll, .fv1-actions, .rf-game-actions, .rf-game-item-picker')) {
          const rect = panel.getBoundingClientRect();
          if (rect.width && (rect.left < box.left || rect.right > box.right || rect.top < box.top || rect.bottom > box.bottom)) problems.push('Activity content escaped frame');
        }
        if ([...document.querySelectorAll('button,input,canvas')].some(node => !frame.contains(node))) problems.push('Game control outside frame');
        return problems;
      }), []);
    }
    await bounds();
    await choose('Sample Friend A');
    await page.locator('.rf-game-wallet').waitFor();
    await page.screenshot({ path: `/tmp/friendsdk-world-${viewport.width}.png` });
    await button('Bait & tackle').click();
    await bounds();
    await page.screenshot({ path: `/tmp/friendsdk-shop-${viewport.width}.png` });
    await button('Buy bait').click();
    await bounds();
    await button('Confirm preview').click();
    await page.getByText('Bought 1 bait with simulated RF.', { exact: true }).waitFor();
    await button('Close Bait & tackle').click();
    assert.equal(await page.getByTestId('bait').textContent(), '1');
    await button('Choose Friend').click();
    await choose('Sample Friend B');
    assert.equal(await page.getByTestId('bait').textContent(), '0', 'Second Friend cannot use first Friend bait');
    assert.equal(await page.getByTestId('balance').textContent(), '20 RF');
    await button('Choose Friend').click();
    await choose('Sample Friend A');
    assert.equal(await page.getByTestId('bait').textContent(), '1', 'Switching preserves original inventory');
    const canvas = page.locator('.fv1-world canvas');
    const before = await canvas.getAttribute('data-x');
    await canvas.focus();
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(200);
    await page.keyboard.up('ArrowRight');
    assert.notEqual(await canvas.getAttribute('data-x'), before, 'Keyboard movement works inside the container');
    if (viewport.width < 500) {
      const touchBefore = await canvas.getAttribute('data-x');
      await canvas.tap();
      await page.waitForTimeout(200);
      assert.notEqual(await canvas.getAttribute('data-x'), touchBefore, 'Touch movement works inside the container');
    }
    await button('Go fishing').click();
    await bounds();
    await page.screenshot({ path: `/tmp/friendsdk-pond-${viewport.width}.png` });
    await button('Cast · 1 bait').click();
    await button('Confirm preview').click();
    await button('Reel in').click();
    await button('Keep catch').click();
    await page.getByText('1 owned · 0.25 RF · No expiry', { exact: true }).waitFor();
    await bounds();
    assert.equal(await page.locator('.fv1-collection > button').count(), 8);
    assert.ok(await page.locator('.fv1-collection > button').evaluateAll(cards => cards.every(card => card.getBoundingClientRect().height >= 52 && card.querySelector('svg').getBoundingClientRect().height >= 24)), 'Collection cards and artwork remain readable');
    await page.screenshot({ path: `/tmp/friendsdk-collection-${viewport.width}.png` });
    await page.getByRole('button', { name: 'Legend, 0 owned', exact: true }).scrollIntoViewIfNeeded();
    await page.locator('.fv1-catch-detail').scrollIntoViewIfNeeded();
    await bounds();
    await button('Sell one Sardine').click();
    await button('Confirm preview').click();
    await page.getByText('Sold 1 Sardine. Simulated RF added to this Friend.', { exact: true }).waitFor();
    await button('Close Your catches').click();
    await button('Open Friend wallet').click();
    await page.getByRole('dialog', { name: 'Friend wallet', exact: true }).getByText('19.25 RF', { exact: true }).waitFor();
    await bounds();
    await button('Close Friend wallet').click();
    await button('Settings').click();
    await button('Odds').click();
    await page.getByRole('cell', { name: '10 RF', exact: true }).scrollIntoViewIfNeeded();
    await bounds();
    await button('Close Odds').click();
    await button('Settings').click();
    await button('Reset walking position').click();
    await bounds();
    await button('Close Settings').click();
    await page.screenshot({ path: `/tmp/friendsdk-frame-${viewport.width}.png` });
    assert.deepEqual(errors, [], 'No browser runtime errors');
    await context.close();
    console.log(`PASS ${viewport.width}px: world prompts, contained menus, selection, separate ledgers, buy/cast/keep/sell, wallet, odds, settings.`);
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
