---
name: create-plan
description: Creates a codebase-grounded implementation plan in docs/plan-<slug>.md from an explicitly identified FriendSDK intent. Use only when the user explicitly invokes /create-plan.
disable-model-invocation: true
---

# Create Plan

Turn an agreed intent into an implementation-ready plan grounded in the
repository's current code, conventions, checks and tests.

Keep oracle-management plans under `docs/oracle/plan-<slug>.md`; other plans use
`docs/plan-<slug>.md`. Read related documents in the same topic folder.

## Repository context

FriendSDK is an isolated prototype kit for small RF chance games. The plan must
stay inside the rules fixed by `AGENTS.md`, `README.md`, `API.md` and, for
contracts, `contracts/AGENTS.md` and `contracts/COMMANDMENTS.md`. The layers
and where their proof lives:

| Layer | Source | Proof |
| --- | --- | --- |
| SDK modules | `src/` | `tests/*.test.mjs` via `npm test`; `npm run typecheck` |
| Games and examples | `examples/`, `games/` | `npm run check:games`; the local preview |
| Host transport and bridge | `src/chain.ts`, `src/frame-bridge.ts` | `tests/chain.test.mjs`, `tests/frame-bridge.test.mjs` |
| Deployment and resolution tooling | `scripts/contracts/` | `tests/contracts-cli.test.mjs`, `tests/contracts-anvil.test.mjs` |
| Contracts | `contracts/src/` | `contracts/test/*.t.sol` via `npm run test:contracts`; optional `MainnetForkTest` |
| Generated bindings | `src/chance-game-abi.ts` | `npm run verify:contracts` |

Fixed rules the plan must not work around:

- Game code runs in a sandboxed 960 × 640 frame and calls only the fixed
  actions (read, canBuy, buy, play, settle, redeem). It never imports the host
  transport; `scripts/check-games.mjs` rejects that.
- RF amounts are `bigint` base units; outcome weights total 10,000 basis points.
- Contracts determine paid outcomes. Presentation never changes a paid result,
  and nothing claims a transaction without a confirmed receipt.
- Contract terms are immutable. Any Solidity change requires
  `npm run build:contracts`, `npm run sync:contracts` and `npm run build`, and
  means a new deployment; existing obligations stay with the old game.
- No rerolls, cancellation, fallback entropy, mutable provider, pause controls,
  proxies or administrators in contracts.
- No private keys in source, environment files, manifests or logs. No mainnet
  broadcast from automated checks or CI.
- No production web routes, dependencies or assets; the production app has no
  SDK integration.

## Player-facing integrity — designed in, not hoped for

A plan that lets the game or tooling present something untrue is worse than no
plan. For every output the change can emit, answer both: *could this be shown
when it isn't true, and what real step must have happened for it to be valid?*
The second answer must be enforced in code the plan names — not merely intended.

- The plan carries an explicit integrity section listing the risks it found and
  the mechanism that closes each one.
- Watch for the recurring cases: preview or simulated data reaching a live
  path; a displayed price, odd or reward kept in a second copy instead of the
  game definition or deployed terms; a failed, replaced or reorganized
  transaction reported as success; a pending play or unfulfilled request shown
  as settled; a caveat that exists in prose but not in the output.
- One source of truth per rule. If the change introduces a second place a
  price, reserve, balance or outcome can be computed, the plan says why and how
  they are pinned together.
- Where a guard is what keeps an output honest, the plan pins it with a test in
  the matching `tests/*.test.mjs` file or `contracts/test/*.t.sol`, alongside
  the existing ones.

## Non-negotiable workflow

1. Always ask the user to identify the source intent file. Do not infer it.
2. Read the complete intent, `AGENTS.md`, `README.md` and `API.md`. Read
   `WORLD_RULES.md`, `SOUND_KIT.md`, `FISHING_GAME_DESIGN.md`,
   `contracts/AGENTS.md` and `contracts/COMMANDMENTS.md` when the intent
   touches their areas.
3. Investigate before planning:
   - Read related intents and plans in `docs/`.
   - Trace the relevant code paths, types, data flow, contract state, frame
     boundary, UI states and integration points.
   - Locate existing tests, fixtures, scripts, and analogous implementations,
     including `examples/fishing` as the reference game.
   - Read `.github/workflows/check.yml` to know what the gate runs.
   - Verify every path, symbol, behavior, and command named in the plan.
4. Always ask focused questions before writing:
   - Resolve ambiguities or contradictions in the intent.
   - Confirm implementation constraints, compatibility needs (package exports,
     ABI bindings, deployment manifests), scope boundaries, delivery
     sequencing, and required proof.
   - Present the proposed test list for explicit confirmation: name each new
     or changed test file, what it validates, what it deliberately does NOT
     cover, and any material cost it adds to the gate. Every planned test costs
     review and gate time forever; the list is a decision the user confirms,
     not a detail the plan buries.
   - Present the integrity risks found and the mechanism closing each one, and
     ask the user to confirm none is missing.
   - Propose codebase-supported choices when useful, but ask the user to
     decide; never silently choose.
   - Confirm the topic-appropriate plan path and whether an existing file may
     be replaced.
   - If everything appears settled, summarize the proposed implementation
     direction and ask the user to confirm it.
5. Wait for the answers. Do not write the plan in the same turn as the
   questions.
6. Create or revise the confirmed plan file.
7. Audit the finished plan against the intent and repository. Remove guesses,
   stale references, vague tasks, and untestable completion claims.

Use structured questions when choices are known. Ask conversationally when the
answer needs explanation. Ask only questions whose answers are not already
available in the repository.

## Document standard

The plan must say exactly how the intent will come to life in this codebase
without implementing it.

Use this shape when applicable:

```markdown
# Plan — <short title>

Implements [<intent name>](<relative path>).

## Outcome
<Concrete end state and explicit non-goals.>

## Phase 1 — <coherent implementation slice>
### `<path>` — `<symbol or responsibility>`
- Exact behavior, data-model, API, state, and integration changes.
- Edge cases, failure behavior, compatibility, and migration requirements.

## Integrity risks
- <Output that could be shown untrue> — <the code that prevents it, and the
  test that pins it.>

## Verification
### Tests
- Exact test files and cases to add or update, and the commands that run them:
  `npm test`, `npm run typecheck`, `npm run check:games`,
  `npm run test:contracts`, `npm run verify:contracts`.
### Real-run verification
- The actual run that proves the change and the observable outcome that counts
  as passing: the local preview served from `examples/fishing/dist`, the
  optional browser check `scripts/check-fishing-browser.mjs`, the Anvil test,
  or the local mainnet fork test with `FRIENDSDK_FORK_RPC`. A mainnet
  deployment or play is only ever run explicitly by the developer, never as
  part of the plan's automated proof.

## Delivery order
1. Dependency-aware sequence with independently verifiable slices.

## Done
- Observable, testable completion criteria traced to the intent.
```

Adapt headings to the work; do not add empty boilerplate.

## Planning rules

- Name exact files and symbols where the repository supports that precision.
- Explain contracts and interactions, not merely “update” or “refactor.”
- Separate verified current state from proposed changes.
- Preserve established architecture unless the intent requires changing it:
  the frame boundary, the host-owned transport, the reserve accounting, and
  the immutable contract terms.
- Call out package export changes, ABI regeneration, deployment manifest
  schema changes, and cleanup when they are genuinely relevant.
- Include tests for normal behavior, boundaries, regressions, and failures.
  Contract tests cover backing, wallet payment, callbacks and exact odds;
  transport tests cover receipts, replacements and reorgs; keep those
  properties intact.
- Include the applicable EXISTING checks as regression gates; do not invent new
  evaluation suites. Note when a check needs Foundry installed.
- Plain language: say what happens in ordinary words; explain repository
  shorthand (RF base units, free stake, canonical NFT wallet, batch ID, Dice
  sponsor) on first use or drop it.
- Make phases coherent implementation slices, not arbitrary file groupings.
- Do not hide unresolved decisions in implementation language. Ask first; if
  the user explicitly defers one, mark it as a blocker or named open decision.

## Handoff

After writing, report the plan path and summarize any explicit blockers or
deferred decisions. Do not begin implementation unless the user asks.
