# Proposal: recover unrevealed Dice requests

Add a controller-authorized retry for an unrevealed Dice request on a committed
play group. This is proposed later-phase contract work, not an implemented SDK
runtime action. It applies to new deployments after the required implementation,
review and explicit deployment authorization.

See [oracle operations](README.md) for implemented request and settlement behavior.

## Required behavior

A play group keeps its play IDs, consumables, pending count and reserved backing.
After Dice permits reclaiming an unrevealed request, one atomic action clears
that request and requests a new word for the same group. Each play receives one
outcome; a revealed result can never be retried.

Only the NFT owner or its canonical wallet may trigger the retry. Dice's own
reclaim delay controls availability. Do not add a game-side timer, fallback
randomness source, mutable provider or developer recovery power.

The caller pays the newly quoted Dice fee. The action reclaims the old fee from
Dice, requests new randomness and returns the reclaimed ETH to the caller. A
failure at any step reverts the entire retry. The game holds no ETH after the
operation.

The contract must reject retries for unrequested, fulfilled or settled groups,
for callback states where the word has been revealed, and for stale or cleared
request identifiers. Remove the old sequence binding before installing the new
one. A callback for the reclaimed sequence must fail.

The resolve command detects retry availability, quotes the fee and reclaimed
amount, verifies the Friend owner, simulates the action and requests typed
`RETRY` confirmation. Verify the transaction receipt, retry event and new
request state before reporting success.

## Accounting and limits

Pending plays retain their maximum-prize reserve. Kept rewards retain fixed
value and backing without expiry. Retry changes neither RF balances nor inventory.
Only free stake remains withdrawable by the developer.

This proposal provides no bait/RF refund, play cancellation or recovery from Dice
being paused, removed or incompatible. Such plays retain their reserves. The
proposal cannot change an immutable deployment that lacks the retry function.
A retry enables another request; settlement still depends on successful oracle
delivery.

## Presentation and verification

Show the same play and consumable with a pending status until confirmed settlement.
Label reclaimed ETH as a returned Dice fee, separate from RF rewards. Report test,
local-fork and explicitly authorized mainnet evidence separately.

Acceptance requires controller-only access, correct delay/callback guards,
atomic fee handling, rejection of stale callbacks, one settled outcome and
unchanged backing across retry. Contract, CLI, local-chain and deployed-interface
fork checks are specified in [the implementation plan](plan-recovery.md).
