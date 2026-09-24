// Internal fixture: exercise bridge restarts on the same sandbox document.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build as bundle } from "esbuild";
import { chromium } from "playwright";
import { buildGame, createGameServer } from "./dev-game.mjs";
import { installFixture } from "./check-runtime-browser.mjs";

const outdir = await mkdtemp(join(tmpdir(), "friendsdk-session-browser-"));
let build, server, browser;
try {
  build = await buildGame(resolve("examples/starter"), { outdir });
  // Keep the actual runner host. Replace only its child with a component lifecycle
  // fixture; development StrictMode intentionally replays the initial effects.
  await bundle({ absWorkingDir: process.cwd(), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' }, outfile: join(outdir, "game.js"),
    stdin: { sourcefile: "session-fixture.tsx", resolveDir: process.cwd(), loader: "tsx", contents: `
import {StrictMode,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GameSession} from '@rarefriends/friendsdk/runtime';
import {parseChanceGame} from '@rarefriends/friendsdk/game';
import gameJson from './examples/starter/game.json';
const initial = parseChanceGame(gameJson);
const test = window.__sessionTest = {holdNext:false, held:null, init:null, initializations:0};
window.addEventListener('message', event => {
  if(event.data?.type !== 'friendsdk:init') return;
  test.initializations++; test.init = event.data;
  if(test.holdNext){ test.holdNext=false; test.held=event; event.stopImmediatePropagation(); }
},true);
function Game({friendId,client,paused}){
  const [snapshot,setSnapshot]=useState(null), [error,setError]=useState('');
  useEffect(()=>{let alive=true;client.read().then(value=>{if(alive)setSnapshot(value)}).catch(()=>{});return()=>{alive=false}},[client]);
  async function buy(){try{await client.buy(1n);setSnapshot(await client.read())}catch(error){setError(error.message)}}
  return <section aria-label="Session fixture"><p data-testid="friend">{String(friendId)}</p>
    <p data-testid="count">{snapshot ? String(snapshot.consumables) : 'loading'}</p>
    <button disabled={paused||!snapshot} onClick={buy}>Buy fixture pack</button>{error&&<p>{error}</p>}</section>;
}
function Harness(){const [definition,setDefinition]=useState(initial);
  useEffect(()=>{const restart=()=>setDefinition(value=>({...value}));window.addEventListener('fixture:restart',restart);return()=>window.removeEventListener('fixture:restart',restart)},[]);
  return <GameSession definition={definition}>{props=><Game {...props}/>}</GameSession>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Harness/></StrictMode>);`,
    } });
  server = createGameServer(outdir);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await installFixture(page, origin);
  await page.goto(origin);
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: /^Friend #7730\b/ }).click();
  const child = page.frameLocator("iframe");
  const count = value => child.getByTestId("count").filter({ hasText: new RegExp(`^${value}$`) }).waitFor();
  await count(0);
  assert.equal(await child.getByTestId("friend").textContent(), "7730", "StrictMode starts the correct session");
  await child.getByRole("button", { name: "Buy fixture pack", exact: true }).click();
  await page.getByRole("button", { name: "Confirm preview", exact: true }).click();
  await count(1);
  await child.getByRole("button", { name: "Buy fixture pack", exact: true }).click();
  await page.getByRole("button", { name: "Confirm preview", exact: true }).waitFor();
  await page.locator("iframe").evaluate(node => { node.dataset.originalDocument = "yes"; });
  const previous = await child.locator("body").evaluate(() => {
    const data = window.__sessionTest.init;
    window.__sessionTest.holdNext = true;
    window.dispatchEvent(new Event("fixture:restart"));
    return { documentId: data.documentId, handshakeId: data.handshakeId };
  });
  await page.getByRole("button", { name: "Confirm preview", exact: true }).waitFor({ state: "detached" });
  const gameFrame = page.frames().find(frame => frame.parentFrame());
  await gameFrame.waitForFunction(() => Boolean(window.__sessionTest.held));
  const next = await child.locator("body").evaluate(() => window.__sessionTest.held.data);
  assert.equal(next.documentId, previous.documentId, "Effect restart keeps the same document");
  assert.notEqual(next.handshakeId, previous.handshakeId, "Effect restart creates a new handshake");
  // Reproduce a stale host initialization already queued before the effect reset.
  // It has the real parent source but an old nonce and an unusable port.
  await page.evaluate(previous => {
    const channel = new MessageChannel();
    document.querySelector("iframe").contentWindow.postMessage({ type: "friendsdk:init", ...previous, friendId: 999n }, "*", [channel.port2]);
    channel.port1.close();
  }, previous);
  await child.locator("body").evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    const event = window.__sessionTest.held;
    window.__sessionTest.held = null;
    window.dispatchEvent(new MessageEvent("message", { data: event.data, source: parent, ports: [...event.ports] }));
  });
  await count(1);
  assert.equal(await child.getByTestId("friend").textContent(), "7730", "Stale initialization cannot take the new session");
  assert.equal(await page.locator("iframe").getAttribute("data-original-document"), "yes", "Reconnect without replacing the iframe");
  await child.getByRole("button", { name: "Buy fixture pack", exact: true }).click();
  await page.getByRole("button", { name: "Confirm preview", exact: true }).click();
  await count(2);
  assert.deepEqual(errors, []);
  console.log("PASS child session: development StrictMode, same-document definition restart, stale init rejection, pending approval cancellation, preserved ledger, continued actions.");
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await build?.close();
  await rm(outdir, { recursive: true, force: true });
}
