import type { FrameLocator, Page } from "playwright";

export type GameTestContext = Readonly<{
  /** Trusted runtime, wallet picker and confirmations. */
  page: Page;
  /** The sandboxed game document; use this for game controls and canvas. */
  game: FrameLocator;
  friendId: bigint;
  account: `0x${string}`;
  friendWallet: `0x${string}`;
}>;

export type GameTestOptions = Readonly<{
  /** Browser viewport width. Defaults to 960; widths below 500 enable touch. */
  width?: number;
  /** Browser viewport height. Defaults to 800. */
  height?: number;
  /** Capture the game container after your checks. Relative to the working directory. */
  screenshot?: string;
  /** Playwright action/navigation timeout in milliseconds. Defaults to 15000. */
  timeout?: number;
  /** Wait for your game's artwork/UI, then exercise the interactions you need. */
  check?: (context: GameTestContext) => void | Promise<void>;
}>;

export type GameTestResult = Readonly<{
  gameDirectory: string;
  friendId: "7730";
  width: number;
  height: number;
  screenshot?: string;
}>;

/**
 * Build and run headless Chromium with mocked wallet/RPC and canonical sample art.
 * Uses the real ownership gate and sandbox; never signs or contacts a real RPC.
 * Requires Playwright and its Chromium installation. Always closes the browser
 * and temporary server after the check; this does not create a playable preview.
 */
export function testGame(gameDirectory: string, options?: GameTestOptions): Promise<GameTestResult>;
