---
name: create-intent
description: Creates or revises docs/intent-<slug>.md from raw game, SDK, tooling or contract ideas for FriendSDK. Use only when the user explicitly invokes /create-intent.
disable-model-invocation: true
---

# Create Intent

Turn rough ideas into a short, human-readable intent that can be discussed and
revised before implementation planning.

## Repository context

FriendSDK is an isolated prototype kit for small RF chance games played with a
hardwired Generations NFT on Robinhood mainnet. Read these before anything else:

- `AGENTS.md` — the non-negotiable game, boundary and safety rules.
- `README.md` — v0.1 setup, the AI-agent game workflow and submission requirements.
- `API.md` — the exported modules, the host transport and the hosting boundary.
- `WORLD_RULES.md`, `SOUND_KIT.md`, `FISHING_GAME_DESIGN.md` — when the idea
  touches scenes, Friend sprites, audio or the fishing reference.
- `contracts/AGENTS.md` and `contracts/COMMANDMENTS.md` — when the idea
  touches Solidity, deployment tooling or the Dice flow.
- `docs/oracle/README.md` — when the idea concerns oracle operations or recovery.

Keep oracle-management intents under `docs/oracle/intent-<slug>.md`; other
intents use `docs/intent-<slug>.md`.

An intent must respect the rules already fixed by those documents. If the raw
idea conflicts with one (a second currency, an expiry window, UI outside the
960 × 640 container, a game requesting a signer, a rerollable result, a mutable
contract term), say so in chat and ask the user to resolve it; do not write the
conflict into the intent as if it were agreed.

## Player-facing integrity — before writing anything

Contracts decide paid outcomes. Animation, browser randomness, preview ledgers
and UI copy are presentation only. The intent must name every way the proposed
change could show a player something untrue:

- preview or simulated state that could be read as a live result or balance;
- a transaction, purchase or payout claimed before a confirmed receipt;
- odds, prices or rewards displayed from a second source instead of the game
  definition and deployed terms;
- a pending, failed or skipped step that silently improves what the player sees;
- a caveat that lives in prose or docs but not in the actual output.

State those risks explicitly, in the intent and in chat. Success criteria must
be honest about the evidence: a local preview or a passing unit test is not a
live deployment, and a deployment is not unattended operation.

## Non-negotiable workflow

1. Inspect before asking:
   - Read the repository context above.
   - Read any existing intent for this work in `docs/`.
   - Search the relevant code in `src/`, `examples/`, `games/`, `scripts/`,
     `contracts/src` and the tests in `tests/` and `contracts/test` for the
     ideas the user supplied. Exhaust what is within reach before reasoning
     about what is missing; if anything relevant is left unread, say so.
   - Distinguish verified current behavior from proposals.
2. Always ask the user focused questions before writing or editing the file.
   Never fill a gap with a guess.
   - Clarify the problem, desired outcome, player-visible behavior, scope,
     non-goals, constraints, and what success looks like.
   - Establish which layer the change belongs to: game content, SDK module,
     host transport or bridge, deployment tooling, or contract. Contract
     changes mean a new deployment and new immutable terms; name that.
   - Surface conflicts between the request and the repository rules.
   - If the input appears complete, summarize the intended interpretation and
     ask the user to confirm it.
   - Confirm the topic-appropriate intent path and whether an existing file may
     be replaced.
3. Wait for the answers. Do not write the intent in the same turn as the
   questions.
4. Create or revise the confirmed intent file.
5. Re-read the result and remove assumptions, implementation-plan detail,
   repetition, and unsupported claims.

Use structured questions when choices are known. Ask conversationally when the
answer needs explanation. Ask only questions whose answers are not already
available in the repository.

## Document standard

The intent records **what should become true and why**, not a file-by-file
implementation.

- Start with `# Intent — <short title>`.
- Open with one concise paragraph naming the problem and desired change.
- Organize the body around the few product or system ideas that matter.
- State agreed rules, boundaries, tradeoffs, and non-goals plainly.
- Refer to verified current behavior or paths only when they clarify the
  proposal.
- End with a concrete description of what success looks like when useful.
- Keep unresolved decisions visible only when the user explicitly chooses to
  defer them.
- Prefer prose and short bullets. Use the shortest document that preserves the
  agreed meaning.
- Plain language: describe what happens in ordinary words. Repository
  shorthand — RF base units, basis-point weights, free stake, canonical NFT
  wallet, hardwired Generations NFT, batch ID, Dice sponsor — gets explained on
  first use or dropped. A competent reader who has not been in the room must be
  able to follow every sentence.

Do not include phases, task checklists, exhaustive file lists, guessed APIs, or
a test matrix. Those belong in `/create-plan`.

## Handoff

After writing, report the path and briefly name any deliberately unresolved
questions. Invite discussion and iteration; do not begin implementation or
create a plan unless the user asks.
