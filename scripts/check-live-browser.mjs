// UI/bridge fixture only. All live actions and funding are mocks; no wallet signs.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build as bundle } from 'esbuild';
import { chromium } from 'playwright';
import { buildGame, createGameServer } from './dev-game.mjs';
import { installFixture, assertBounds } from './check-runtime-browser.mjs';

const outdir = await mkdtemp(join(tmpdir(), 'friendsdk-live-browser-'));
const deployment = JSON.parse(await readFile(new URL('../examples/fishing/deployment.json', import.meta.url), 'utf8'));
const gameModule = JSON.stringify(resolve('dist/game.js'));
const fixtureModule = `
import {createGamePreview,RF} from ${gameModule};
export const LIVE_GAME_MAX_ORACLE_FEE=25_000_000_000_000n;
const state=window.__liveFixture??={ledgers:new Map(),credits:new Map(),calls:[],reads:0,topUps:[],blockNext:null,release:null};
export function createLiveGameClient(options){
 if(typeof options.deployment.deploymentBlock!=='bigint')throw Error('Deployment block must be bigint');
 let preview=state.ledgers.get(options.friendId);
 if(!preview){preview=createGamePreview(options.definition,{friendId:options.friendId,stake:100n*RF,rfBalance:20n*RF,draw:()=>1500});state.ledgers.set(options.friendId,preview)}
 async function active(){await options.assertActive?.()}
 async function action(name,args){
  await active();
  if(state.blockNext===name){state.blockNext=null;await new Promise(resolve=>{state.release=resolve})}
  await active();state.calls.push({name,args,friendId:options.friendId});return preview.client[name](...args);
 }
 return {mode:'chain',definition:options.definition,
  async read(){state.reads++;await active();const value=await preview.client.read();return {...value,mode:'chain',rfBalance:value.rfBalance+(state.credits.get(options.friendId)??0n)}},
  canBuy:count=>preview.client.canBuy(count),buy:count=>action('buy',[count]),play:(count=1n)=>action('play',[count]),
  settle:id=>action('settle',[id]),redeem:(id,count)=>action('redeem',[id,count])};
}
export async function fundFriendWallet(options){
 await options.assertActive?.();state.topUps.push({friendId:options.friendId,amount:options.amount});
 state.credits.set(options.friendId,(state.credits.get(options.friendId)??0n)+options.amount);
 return '0x'+'42'.repeat(32);
}`;
let build, server, browser;
try {
  build = await buildGame(resolve('examples/fishing'), { outdir, deployment });
  // The host, sandbox, confirmation menus and fishing component are real. Replace
  // only the transaction adapters; their RPC/receipt behavior has separate tests.
  await bundle({ absWorkingDir: process.cwd(), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(outdir, 'runtime.js'),
    plugins: [{ name: 'mock-live-actions', setup(build) {
      build.onResolve({ filter: /(?:live-game|friend-funding)\.js$/ }, () => ({ path: 'live-fixture', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixtureModule, resolveDir: process.cwd(), loader: 'js' }));
    } }],
    stdin: { sourcefile: 'live-fixture.tsx', resolveDir: process.cwd(), loader: 'tsx', contents: `
import {createRoot} from 'react-dom/client';import {GameHost} from './src/runtime.ts';
import {parseChanceGame} from './src/game.ts';import game from './examples/fishing/game.json';
import './assets/runtime.css';import './assets/game-frame.css';
const deployment=${JSON.stringify(deployment)};deployment.deploymentBlock=BigInt(deployment.deploymentBlock);
createRoot(document.getElementById('root')).render(<GameHost definition={parseChanceGame(game)} deployment={deployment} frameUrl="./game.html"/>);`,
    } });
  server = createGameServer(outdir);
  server.prependListener('request', (_request, response) => {
    const writeHead = response.writeHead.bind(response);
    response.writeHead = (status, headers = {}) => {
      delete headers['Access-Control-Allow-Origin'];
      return writeHead(status, headers);
    };
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await installFixture(page, origin);
  await page.goto(origin);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: /^Friend #7730\b/ }).click();
  const child = () => page.frameLocator('iframe');
  const gameButton = name => child().getByRole('button', { name, exact: true });
  const hostButton = name => page.getByRole('button', { name, exact: true });
  const loaded = () => child().getByRole('region', { name: 'Fishing game', exact: true }).waitFor();
  await loaded();
  assert.equal(await page.locator('.rf-game-frame').getAttribute('data-mode'), 'live');
  assert.equal(await child().getByText('Local preview', { exact: true }).count(), 0);
  assert.equal(await hostButton('Confirm preview').count(), 0);
  await assertBounds(page);

  await hostButton('Open Friend wallet').click();
  await page.getByRole('textbox', { name: 'RF amount', exact: true }).fill('2');
  await hostButton('Transfer RF to Friend').click();
  await page.getByText(/^RF transfer confirmed:/).waitFor();
  await page.getByRole('dialog', { name: 'Friend wallet', exact: true }).getByText('22 RF', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__liveFixture.topUps.map(item => [String(item.friendId), String(item.amount)])), [['7730', '2000000000000000000']]);
  await hostButton('Close Friend wallet').click();
  await loaded();

  await gameButton('Bait & tackle').click(); await gameButton('Buy bait').click();
  await hostButton('Confirm').waitFor();
  assert.equal(await page.evaluate(() => window.__liveFixture.calls.length), 0, 'No chain action before host confirmation');
  await hostButton('Confirm').click();
  await child().getByText('Bought 1 bait.', { exact: true }).waitFor();
  await gameButton('Back to the pond').click();
  const readsBeforeCast = await page.evaluate(() => window.__liveFixture.reads);
  await gameButton('Cast · 1 bait').click();
  await page.getByRole('dialog', { name: 'Use bait', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__liveFixture.reads), readsBeforeCast, 'Casting must open confirmation without a full state refresh');
  await hostButton('Confirm').click();
  await page.getByRole('dialog', { name: 'Resolve result', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__liveFixture.reads), readsBeforeCast, 'Do not insert a redundant read between play and settlement');
  const oracleConfirmation = await page.getByRole('dialog', { name: 'Resolve result', exact: true }).innerText();
  assert.match(oracleConfirmation, /0\.000025 ETH/);
  assert(!oracleConfirmation.includes('0.001 ETH'));
  assert.match(oracleConfirmation, /plans to subsidize RNG costs for all developers/);
  assert.match(oracleConfirmation, /does not include the subsidy/);
  assert.deepEqual(await page.evaluate(() => window.__liveFixture.calls.map(call => call.name)), ['buy', 'play']);
  await assertBounds(page);
  await hostButton('Confirm').click();
  await gameButton('Reel in').click(); await gameButton('Keep catch').click();
  await gameButton('Sell one Sardine').click(); await hostButton('Confirm').click();
  await child().getByText('Sold 1 Sardine. RF returned to this Friend wallet.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__liveFixture.calls.map(call => call.name)), ['buy', 'play', 'settle', 'redeem']);

  // Block an approved action immediately before its mocked transaction boundary,
  // change the connected account, then prove the obsolete session cannot proceed.
  await gameButton('Close Your catches').click();
  await gameButton('Bait & tackle').click();
  await gameButton('Buy bait').click();
  await page.evaluate(() => { window.__liveFixture.blockNext = 'buy'; });
  await hostButton('Confirm').click();
  await page.waitForFunction(() => Boolean(window.__liveFixture.release));
  await page.evaluate(() => window.__friendWalletTest.accounts(['0x2222222222222222222222222222222222222222']));
  await page.getByRole('button', { name: /^Friend #3412\b/ }).waitFor();
  await page.evaluate(() => window.__liveFixture.release());
  await page.getByRole('button', { name: /^Friend #3412\b/ }).click();
  await loaded();
  assert.deepEqual(await page.evaluate(() => window.__liveFixture.calls.map(call => call.name)), ['buy', 'play', 'settle', 'redeem']);
  assert.equal(await child().getByTestId('bait').textContent(), '0');
  assert((await page.evaluate(() => window.__friendWalletTest.state.requests)).every(method => ['eth_accounts', 'eth_requestAccounts', 'eth_chainId'].includes(method)), 'No actual wallet transaction/signature was requested');
  assert.deepEqual(errors, []);
  console.log('PASS live UI/bridge with mocked transactions: chain labels, RF top-up, buy/play/settle/redeem confirmations, stale-session cancellation.');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await build?.close(); await rm(outdir, { recursive: true, force: true });
}
