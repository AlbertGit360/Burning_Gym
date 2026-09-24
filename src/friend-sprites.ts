/** Standalone FriendSDK entry: public artwork reads require no wallet. */
import { createPublicClient, http } from "viem";
import { createGenerationSpriteReader, GENERATION_SPRITE_MANIFEST } from "./generation-sprites.js";

export * from "./generation-sprites.js";

export function createFriendReader() {
  return createGenerationSpriteReader(createPublicClient({
    transport: http(GENERATION_SPRITE_MANIFEST.rpcUrl, { retryCount: 1, timeout: 12_000 }),
  }));
}
