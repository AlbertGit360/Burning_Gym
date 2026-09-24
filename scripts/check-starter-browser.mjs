// Internal automated fixture: real public runner, mocked read-only identity and canonical sprite responses.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { project } from '../dist/friend-world.js';
import { buildGame, createGameServer } from './dev-game.mjs';
import { installFixture, assertBounds, createArtworkFixture } from './browser-fixture.mjs';

const artworkCall = await createArtworkFixture();
async function gameBounds(child) {
  assert.deepEqual(await child.locator('body').evaluate(() => {
    const bounds = document.body.getBoundingClientRect(), problems = [];
    if (document.querySelector('.rf-game-frame,nav')) problems.push('Game contains application scaffolding');
    for (const node of document.querySelectorAll('.rf-frame-menu,.rf-world-prompt,.starter-hud')) {
      const box = node.getBoundingClientRect();
      if (box.left < -1 || box.right > bounds.right + 1 || box.top < -1 || box.bottom > bounds.bottom + 1) problems.push(`Outside viewport: ${node.className}`);
    }
    const canvas = document.querySelector('canvas')?.getBoundingClientRect();
    if (canvas && Math.abs(canvas.width / canvas.height - 1.5) > .01) problems.push('World projection stretched');
    return problems;
  }), []);
}
const directory = await mkdtemp(join(tmpdir(), 'friendsdk-starter-browser-'));
let build, server, browser;
try {
  build = await buildGame(resolve('examples/starter'), { outdir: join(directory, 'dist') });
  server = createGameServer(build.outdir);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1100, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await installFixture(page, origin, { artworkCall });
    // Interrupt only the game-side settlement request to exercise pending-play recovery.
    await page.addInitScript(() => {
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function (message, ...args) {
        if (window !== window.top && window.__failNextSettle && message?.method === 'settle') {
          window.__failNextSettle = false;
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: { type: 'friendsdk:response', id: message.id, error: 'Fixture interrupted settlement' } })), 0);
          return;
        }
        return post.call(this, message, ...args);
      };
    });
    const child = page.frameLocator('iframe');
    const button = name => child.getByRole('button', { name, exact: true });
    const confirm = () => page.getByRole('button', { name: 'Confirm preview', exact: true }).click();
    const worldReady = () => child.locator('canvas[data-x]').waitFor();
    const walk = async point => {
      const canvas = child.locator('canvas'), box = await canvas.boundingBox(), [x, y] = project(...point);
      const position = { x: (x - 320) / 960 * box.width, y: (y - 330) / 640 * box.height };
      if (width < 500) await canvas.tap({ position }); else await canvas.click({ position });
    };
    const buy = async () => {
      await child.getByRole('button', { name: /^Pack dispenser/ }).click();
      await button('Buy one pack · 1 RF').click(); await confirm();
      await child.getByText('One simulated pack added to your Friend.', { exact: true }).waitFor();
      await button('Close Pack dispenser').click();
    };
    const goOpen = async () => {
      await walk([356, 250]);
      await child.getByRole('button', { name: /^Open a pack/ }).click();
    };
    await page.goto(origin);
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    await page.getByRole('button', { name: /^Friend #7730\b/ }).click(); await worldReady();
    await assertBounds(page); await gameBounds(child);
    const canvas = child.locator('canvas'), before = await canvas.getAttribute('data-x');
    await canvas.focus(); await page.keyboard.down('ArrowRight'); await page.waitForTimeout(120); await page.keyboard.up('ArrowRight');
    assert.notEqual(await canvas.getAttribute('data-x'), before, 'Canonical owned Friend moves with keyboard');
    if (width < 500) {
      const beforeTouch = await canvas.getAttribute('data-x'); await walk([275, 192]); await page.waitForTimeout(300);
      assert.notEqual(await canvas.getAttribute('data-x'), beforeTouch, 'Tap movement works inside the scaled container');
    }
    await buy(); await goOpen(); await button('Open one pack').click(); await confirm();
    await child.getByRole('heading', { name: 'Garden pebble', exact: true }).waitFor();
    await gameBounds(child); await button('Keep collectible').click();
    await button('Inventory · 1').click();
    await child.locator('.starter-item').first().getByRole('button', { name: 'Redeem one', exact: true }).click(); await confirm();
    await child.locator('.starter-item').first().getByText('0 owned · 0.5 RF', { exact: true }).waitFor();
    await button('Close Inventory').click();
    assert.match(await child.locator('.starter-hud').textContent(), /19\.5 RF/);
    await button('Settings').click(); assert.equal(await child.getByLabel('Reduce motion').isChecked(), true);
    await button('Sound off').click(); await button('Sound on').waitFor();
    await button('Sound on').click(); await button('Sound off').waitFor();
    await child.getByLabel('Reduce motion').uncheck(); assert.equal(await child.getByLabel('Reduce motion').isChecked(), false);
    await gameBounds(child); await button('Close Settings').click();
    await walk([170, 205]); await buy(); await goOpen();
    await child.locator('body').evaluate(() => { window.__failNextSettle = true; });
    await button('Open one pack').click(); await confirm();
    await child.getByText('Fixture interrupted settlement', { exact: true }).waitFor();
    // Reload only the sandbox document: the host-owned preview ledger survives.
    await page.locator('iframe').evaluate(node => { node.src = `${node.src.split('?')[0]}?reload=pending`; });
    await worldReady(); await goOpen(); await button('Finish pending opening').click();
    await child.getByRole('heading', { name: 'Garden pebble', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm preview', exact: true }).count(), 0, 'Restoring a pending opening consumes no second pack');
    await button('Keep collectible').click(); await button('Inventory · 1').waitFor();
    assert.match(await child.locator('.starter-hud').textContent(), /18\.5 RF.*0 packs/);
    await assertBounds(page); await gameBounds(child);
    await page.screenshot({ path: join(tmpdir(), `friendsdk-starter-${width}.png`) });
    assert.deepEqual(errors, []);
    assert((await page.evaluate(() => window.__friendWalletTest.state.requests)).every(method => ['eth_accounts', 'eth_requestAccounts', 'eth_chainId'].includes(method)));
    await context.close();
    console.log(`PASS generic starter ${width}px: canonical artwork, keyboard/touch, world interactions, buy/open/keep/redeem, pending recovery, mute/reduced motion, container bounds.`);
  }
  const page = await browser.newPage();
  let failArt = true;
  await installFixture(page, origin, { artworkCall: call => failArt ? '0x' : artworkCall(call) });
  await page.goto(origin); await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: /^Friend #7730\b/ }).click();
  const child = page.frameLocator('iframe');
  await child.getByRole('button', { name: 'Retry artwork', exact: true }).waitFor();
  assert.equal(await child.locator('canvas[data-x]').count(), 0, 'Failed canonical artwork never substitutes a sample player');
  failArt = false; await child.getByRole('button', { name: 'Retry artwork', exact: true }).click();
  await child.locator('canvas[data-x]').waitFor(); await page.close();
  console.log('PASS generic starter canonical artwork failure and retry.');
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await build?.close(); await rm(directory, { recursive: true, force: true });
}
