# Standalone FriendSDK contracts

Read [COMMANDMENTS.md](COMMANDMENTS.md) and the repository's game rules before changing Solidity. The commandments' Genesis-specific storage list and owner methods describe that deployed contract; this package implements new game contracts only. Apply their house style and minimal-scope rules here.

- Keep only the game, its bound consumable, external-call interfaces, and their tests. No original Rare Friends protocol implementation belongs in this package. Test doubles belong in `test/` only.
- RF, Generations, its canonical NFT wallet, and Dice Protocol are existing mainnet dependencies. Do not redeploy or modify them.
- Mainnet deployment and transactions require explicit authorization. The deploying developer manages the game's free stake. Deployment does not authorize publication or changes to another application.
- Preserve canonical-wallet payment, maximum-prize reserves, permanent rewards, immutable terms, and nontransferable game inventory. Only free stake may be withdrawn.
- Use Dice's explicit `requestV2(provider, userRandomNumber, gasLimit)` interface. Authenticate callbacks and bind each request once. Do not add rerolls, cancellation, fallback entropy, or mutable provider selection.
- Deployment tooling prompts for a private key locally without echo. Never store it or pass it through shell arguments, environment variables, manifests, or logs.
- Build and test locally; a mainnet fork is a local test. Do not broadcast a deployment or test transaction as part of automated checks.
