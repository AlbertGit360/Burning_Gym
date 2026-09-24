// Automated fixture only: the actual public runner/runtime with mocked wallet and RPC.
// Run after npm run build and npx playwright install chromium.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { buildGame, createGameServer } from "./dev-game.mjs";
import { installFixture, assertBounds, SECOND_OWNER } from "./browser-fixture.mjs";
export { installFixture, assertBounds } from "./browser-fixture.mjs";

export async function checkRuntimeBrowser() {
const directory = await mkdtemp(join(tmpdir(), "friendsdk-runtime-browser-"));
let build, server, browser;
try {
  build = await buildGame(resolve("examples/fishing"), { outdir: join(directory, "dist"), watch: false });
  server = createGameServer(build.outdir);
  // Exercise generated assets under ordinary static hosting without CORS setup.
  server.prependListener("request", (_request, response) => {
    const writeHead = response.writeHead.bind(response);
    response.writeHead = (status, headers = {}) => {
      delete headers["Access-Control-Allow-Origin"];
      return writeHead(status, headers);
    };
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });

  const missingWallet = await browser.newPage();
  await missingWallet.goto(origin);
  await missingWallet.getByText("No browser wallet found. Enable your wallet extension or open this game in your wallet’s browser.", { exact: true }).waitFor();
  assert.equal(await missingWallet.getByText("No playable Friends found.", { exact: true }).count(), 0);
  assert.equal(await missingWallet.locator("iframe").count(), 0);
  await missingWallet.close();

  for (const width of [1100, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: "reduce", hasTouch: width < 500 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await installFixture(page, origin, { initialChain: "0x1" });
    const child = () => page.frameLocator("iframe");
    const hostButton = name => page.getByRole("button", { name: name === "Connect wallet" ? /^Connect (wallet|Browser wallet)$/ : name, exact: true });
    const gameButton = name => child().getByRole("button", { name, exact: true });
    const loaded = () => child().getByRole("region", { name: "Fishing game", exact: true }).waitFor();
    const chooseFriend = id => page.getByRole("button", { name: new RegExp(`^Friend #${id}\\b`) }).click();
    await page.goto(origin);
    await hostButton("Connect wallet").waitFor();
    await page.getByText("Connect your wallet to find your Friends on Robinhood.", { exact: true }).waitFor();
    assert.equal(await page.getByText("No playable Friends found.", { exact: true }).count(), 0);
    assert.equal(await page.locator("iframe").count(), 0, "No child before a wallet and eligible NFT");
    assert.equal(await page.evaluate(() => window.__friendWalletTest.state.requests.includes("eth_requestAccounts")), false);
    assert.equal(fixture.requests.length, 0, "No owned NFT requests before connection");
    await assertBounds(page);
    await hostButton("Connect wallet").click();
    await hostButton("Switch to Robinhood").waitFor();
    assert.equal(fixture.requests.length, 0, "No discovery on Ethereum");
    assert.equal(await page.getByText("No playable Friends found.", { exact: true }).count(), 0);
    await page.evaluate(() => { window.__friendWalletTest.state.switchError = 4001; });
    await hostButton("Switch to Robinhood").click();
    await page.getByText("Network switch declined. Try again when ready.", { exact: true }).waitFor();
    assert.equal(await page.locator("iframe").count(), 0);
    await page.evaluate(() => { window.__friendWalletTest.state.switchError = null; });
    await hostButton("Switch to Robinhood").click();
    await page.getByRole("button", { name: /^Friend #7730\b/ }).waitFor();
    if (width === 1100) {
      fixture.hold = new Promise(resolve => { fixture.release = resolve; });
      fixture.mode = "loading";
    }
    await chooseFriend(7730);
    if (width === 1100) {
      await page.getByText("Checking ownership and hardwired eligibility…", { exact: true }).waitFor();
      assert.equal(await page.locator("iframe").count(), 0, "Eligibility loading never enables the game");
      fixture.mode = "eligible";
      fixture.release();
    }
    await loaded();
    assert(fixture.ownerReads >= 2, "Verify selected ownership freshly after discovery");
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
    assert.equal(await child().locator("body").evaluate(() => { try { return Boolean(parent.document); } catch { return false; } }), false);
    assert.equal(await child().locator(".rf-game-frame").count(), 0, "Child is a game component without a nested frame");
    await assertBounds(page);
    await gameButton("Bait & tackle").click();
    await gameButton("Buy bait").click();
    await hostButton("Confirm preview").waitFor();
    await assertBounds(page);
    await hostButton("Confirm preview").click();
    await child().getByText("Bought 1 bait with simulated RF.", { exact: true }).waitFor();
    await gameButton("Back to the pond").click();
    await gameButton("Close The lake").first().click();
    assert.equal(await child().getByTestId("bait").textContent(), "1");
    const canvas = child().locator(".fv1-world canvas");
    const beforeMovement = await canvas.getAttribute("data-x");
    await canvas.focus();
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(150);
    await page.keyboard.up("ArrowRight");
    assert.notEqual(await canvas.getAttribute("data-x"), beforeMovement, "Owned Friend moves with keyboard controls");
    if (width < 500) {
      const beforeTouch = await canvas.getAttribute("data-x");
      await canvas.tap();
      await page.waitForTimeout(150);
      assert.notEqual(await canvas.getAttribute("data-x"), beforeTouch, "Owned Friend moves with touch controls");
    }

    // Changing the wallet cancels the exact open confirmation and stale bridge.
    await gameButton("Bait & tackle").click();
    await gameButton("Buy bait").click();
    await hostButton("Confirm preview").waitFor();
    await page.evaluate(account => window.__friendWalletTest.accounts([account]), SECOND_OWNER);
    await chooseFriend(3412);
    await loaded();
    assert.equal(await hostButton("Confirm preview").count(), 0);
    assert.equal(await child().getByTestId("bait").textContent(), "0");
    await page.evaluate(() => window.__friendWalletTest.chain("0x1"));
    await page.locator("iframe").waitFor({ state: "detached" });
    await page.getByText(/4663/).waitFor();
    await assertBounds(page);
    await hostButton("Switch to Robinhood").click();
    await chooseFriend(3412);
    await loaded();
    await page.evaluate(() => window.__friendWalletTest.disconnect());
    await page.locator("iframe").waitFor({ state: "detached" });
    await hostButton("Connect wallet").waitFor();
    assert((await page.evaluate(() => window.__friendWalletTest.state.requests)).every(method => ["eth_accounts", "eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain"].includes(method)));
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS public runtime ${width}px: connection, owner-indexed discovery, fresh gate, sandbox, simulated purchase, account/network/disconnect cancellation, container bounds.`);
  }

  for (const mode of ["unowned", "unhardwired", "owner-changed", "rpc-error"]) {
    const page = await browser.newPage();
    const fixture = await installFixture(page, origin, { initialChain: "0x1" });
    fixture.mode = mode;
    await page.goto(origin);
    await page.getByRole("button", { name: /^Connect (wallet|Browser wallet)$/ }).click();
    await page.getByRole("button", { name: "Switch to Robinhood", exact: true }).click();
    if (mode === "owner-changed") {
      await page.getByRole("button", { name: /^Friend #7730\b/ }).click();
      await page.getByRole("button", { name: "Retry eligibility", exact: true }).waitFor();
    } else {
      await page.getByRole("button", { name: /^(Refresh Friends|Retry loading Friends)$/ }).waitFor();
      // Wait for a terminal state after wallet connection, not the initial empty picker.
      if (mode === "rpc-error") await page.getByRole("alert").filter({ hasText: /Fixture RPC unavailable|could not/i }).waitFor({ timeout: 20_000 });
      else if (mode === "unhardwired") await page.getByText("1 Friend hidden: not hardwired (generation 0). Playing requires generation 1 or higher.", { exact: true }).waitFor();
      else await page.getByText("No Rare Friends Generations NFTs found in this wallet on Robinhood.", { exact: true }).waitFor();
      assert.equal(await page.getByText("No playable Friends found.", { exact: true }).count(), 0);
      if (mode === "rpc-error") {
        fixture.mode = "eligible";
        await page.getByRole("button", { name: "Retry loading Friends", exact: true }).click();
        await page.getByRole("button", { name: /^Friend #7730\b/ }).waitFor();
      }
    }
    assert.equal(await page.locator("iframe").count(), 0, `No playable game for ${mode}`);
    await assertBounds(page);
    await page.close();
    console.log(`PASS public runtime eligibility failure: ${mode}.`);
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await build?.close();
  await rm(directory, { recursive: true, force: true });
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await checkRuntimeBrowser();
