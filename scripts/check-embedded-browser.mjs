// npm run build
// npm run check:browser
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createEmbeddedFixtureServer } from './serve-embedded.mjs';

const server = createEmbeddedFixtureServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1100, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce', hasTouch: width < 500 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('blob:') ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const original = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = array => { if (array instanceof Uint32Array && array.length === 1) { array[0] = 1500; return array; } return original(array); };
    });
    await page.goto(origin);
    const child = () => page.frameLocator('iframe');
    const gameButton = name => child().getByRole('button', { name, exact: true });
    const hostButton = name => page.getByRole('button', { name, exact: true });
    const update = values => page.evaluate(detail => window.dispatchEvent(new CustomEvent('friendsdk:test-context', { detail })), values);
    const select = (id, label) => page.evaluate(({ id, label }) => window.dispatchEvent(new CustomEvent('friendsdk:test-context', { detail: { selectedFriend: { id: BigInt(id), label, kind: 'sample' } } })), { id, label });
    const loaded = async () => { await child().getByRole('region', { name: 'Fishing game', exact: true }).waitFor(); };
    async function bounds() {
      assert.deepEqual(await page.evaluate(() => {
        const frame = document.querySelector('.rf-game-frame'), box = frame.getBoundingClientRect(), problems = [];
        if (Math.abs(box.width / box.height - 1.5) > .01) problems.push('Viewport aspect ratio changed');
        if (document.documentElement.scrollWidth > innerWidth) problems.push('Page overflow');
        for (const menu of document.querySelectorAll('.rf-frame-menu')) {
          const rect = menu.getBoundingClientRect();
          if (rect.left < box.left || rect.right > box.right || rect.top < box.top || rect.bottom > box.bottom) problems.push('Host menu escaped frame');
        }
        if ([...document.querySelectorAll('button,input,iframe')].some(node => !frame.contains(node))) problems.push('Host control outside container');
        return problems;
      }), []);
      assert.deepEqual(await child().locator('body').evaluate(body => {
        const problems = [];
        for (const menu of body.querySelectorAll('.rf-frame-menu')) {
          const rect = menu.getBoundingClientRect();
          if (rect.left < 0 || rect.right > innerWidth + 1 || rect.top < 0 || rect.bottom > innerHeight + 1) problems.push('Child menu escaped frame');
        }
        for (const control of body.querySelectorAll('.fv1-actions button, [role="tab"], .rf-frame-menu-heading button')) {
          const rect = control.getBoundingClientRect();
          if (rect.left < 0 || rect.right > innerWidth + 1 || rect.top < 0 || rect.bottom > innerHeight + 1) problems.push('Primary menu control clipped');
        }
        for (const card of body.querySelectorAll('.fv1-collection > button')) {
          if (card.getBoundingClientRect().height < 40) problems.push('Collection card crushed');
        }
        return problems;
      }), []);
    }
    await loaded();
    assert.equal(await hostButton('Choose Friend').count(), 0);
    assert.equal(await hostButton('Connect wallet').count(), 0);
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await child().locator('body').evaluate(() => { try { return Boolean(parent.document); } catch { return false; } }), false, 'Child cannot read host DOM');
    await bounds();
    await gameButton('Bait & tackle').click();
    await gameButton('Buy bait').click();
    await page.getByRole('dialog', { name: 'Buy bait', exact: true }).waitFor();
    await bounds();
    await hostButton('Confirm preview').click();
    await child().getByText('Bought 1 bait with simulated RF.', { exact: true }).waitFor();
    await gameButton('Back to the pond').click();
    await gameButton('Close The lake').first().click();
    assert.equal(await child().getByTestId('bait').textContent(), '1');
    await hostButton('Open Friend wallet').click();
    await page.getByRole('dialog', { name: 'Friend wallet', exact: true }).getByText('19 RF', { exact: true }).waitFor();
    assert.equal(await hostButton('Change Friend').count(), 0);
    await bounds();
    const canvas = child().locator('.fv1-world canvas');
    const pausedX = await canvas.getAttribute('data-x');
    await canvas.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    await page.waitForTimeout(150);
    assert.equal(await canvas.getAttribute('data-x'), pausedX, 'Host menu pauses child input');
    await canvas.evaluate(node => node.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })));
    await hostButton('Close Friend wallet').click();
    await canvas.focus(); await page.keyboard.down('ArrowRight'); await page.waitForTimeout(150); await page.keyboard.up('ArrowRight');
    assert.notEqual(await canvas.getAttribute('data-x'), pausedX, 'Keyboard movement resumes');

    await gameButton('Bait & tackle').click(); await gameButton('Buy bait').click();
    await page.getByRole('dialog', { name: 'Buy bait', exact: true }).waitFor();
    await child().locator('body').evaluate(() => location.reload());
    await hostButton('Confirm preview').waitFor({ state: 'detached' });
    await loaded();
    assert.equal(await child().getByTestId('bait').textContent(), '1', 'Reload cancels pending approval and reconnects the same ledger');

    // Pending actions must be cancelled by every host identity boundary.
    for (const change of [
      async () => { await select('3412', 'Host sample Friend B'); },
      async () => { await update({ account: '0x0000000000000000000000000000000000000002' }); },
    ]) {
      await gameButton('Bait & tackle').click(); await gameButton('Buy bait').click();
      await page.getByRole('dialog', { name: 'Buy bait', exact: true }).waitFor();
      await change(); await loaded();
      assert.equal(await hostButton('Confirm preview').count(), 0, 'Old approval disappears');
      assert.equal(await child().getByTestId('bait').textContent(), '0');
      assert.equal(await child().getByTestId('balance').textContent(), '20 RF');
    }
    await gameButton('Bait & tackle').click(); await gameButton('Buy bait').click();
    await page.getByRole('dialog', { name: 'Buy bait', exact: true }).waitFor();
    await update({ chainId: 1 });
    await page.getByText('Switch your wallet to Robinhood mainnet (4663).', { exact: true }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0, 'Wrong network removes the previous child');
    assert.equal(await hostButton('Confirm preview').count(), 0);
    await update({ chainId: 4663 }); await loaded();
    assert.equal(await child().getByTestId('bait').textContent(), '0', 'Network change cancelled the pending purchase');
    await update({ account: '0x0000000000000000000000000000000000000001', chainId: 4663 });
    await select('7730', 'Host sample Friend A'); await loaded();
    assert.equal(await child().getByTestId('bait').textContent(), '1', 'Original Friend ledger survives without cancelled purchases');
    await gameButton('Go fishing').click();
    await gameButton('Cast · 1 bait').click(); await hostButton('Confirm preview').click();
    await gameButton('Reel in').click(); await gameButton('Keep catch').click();
    await bounds();
    await gameButton('Sell one Sardine').click(); await hostButton('Confirm preview').click();
    await child().getByText('Sold 1 Sardine. Simulated RF added to this Friend.', { exact: true }).waitFor();
    await bounds();
    await update({ definitionName: 'Replacement game definition' });
    await loaded();
    assert.equal(await child().getByTestId('balance').textContent(), '20 RF', 'Replacing terms resets the ledger and remounts the child');
    assert.equal(await child().getByTestId('bait').textContent(), '0');
    await page.screenshot({ path: `/tmp/friendsdk-embedded-${width}.png` });
    assert.deepEqual(errors, [], 'No browser runtime errors');
    await context.close();
    console.log(`PASS embedded ${width}px: sandbox, inherited context, confirmations, menu pause, movement, separate ledgers, buy/cast/keep/sell, container bounds.`);
  }
  const page = await browser.newPage();
  await page.goto(origin);
  await page.frameLocator('iframe').getByRole('region', { name: 'Fishing game', exact: true }).waitFor();
  for (const identity of ['unowned', 'unhardwired', 'error', 'loading']) {
    await page.evaluate(identity => window.dispatchEvent(new CustomEvent('friendsdk:test-context', { detail: { identity } })), identity);
    const text = identity === 'loading' ? 'Checking ownership and hardwired eligibility…'
      : identity === 'error' ? 'Could not verify this Friend. Fixture RPC unavailable.'
      : 'The connected account must own this hardwired Generations Friend (generation 1 or higher).';
    await page.getByText(text, { exact: true }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0, `No playable child for ${identity}`);
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('friendsdk:test-context', { detail: { identity: 'eligible' } })));
  await page.frameLocator('iframe').getByRole('region', { name: 'Fishing game', exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('friendsdk:test-context', { detail: { selectedFriend: null } })));
  await page.getByText('Connect a wallet and choose an owned hardwired Friend.', { exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('friendsdk:test-context', { detail: { selectedFriend: { id: 7730n, label: 'Sample', kind: 'sample' }, frameUrl: '/missing.html' } })));
  await page.getByRole('button', { name: 'Retry game', exact: true }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Retry game', exact: true }).click();
  await page.getByText('Loading game preview…', { exact: true }).waitFor();
  console.log('PASS embedded: wrong owner, generation zero, eligibility loading/failure, missing context, failed frame load, retry.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
