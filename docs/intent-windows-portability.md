# Proposal: Windows portability for the SDK toolchain

Target consistent SDK builds, checks, game development and developer tooling on
Windows, Linux and macOS. This proposal describes planned work; completion
requires the platform checks below.

## Requirements

Node.js is required for SDK and game work. Foundry (`forge` and `anvil`) is
optional unless contract checks are requested. On Windows without Foundry,
`npm test`, `npm run typecheck` and `npm run check:games` must pass; the Anvil
integration test must report its missing-tool skip reason.

Convert file URLs with `fileURLToPath` before passing them to filesystem or
bundler APIs. Use `os.tmpdir()` for browser screenshots and temporary fixtures.

## Deployment manifest permissions

Deployment manifests contain contract addresses, immutable terms and transaction
hashes. They must never contain a private key. Restrict access to the creating
account using mode `0600` on POSIX and an owner-only ACL on Windows. Tests must
verify the actual platform restriction.

Apply Windows ACLs through a system tool using an argument array, without a
shell. If restriction fails, save the deployment record and print a warning
naming the file and failure. Private keys remain confined to hidden terminal
input and are never written to source, environment files or deployment records.

## Local server and browser checks

Use a package-owned Node HTTP server for the generic game runner and internal
browser fixtures. Serve only the selected build directory on a loopback address.
Support portable paths, correct content types, GET/HEAD, path confinement and
cache-disabled responses. Report missing builds and occupied ports clearly.

The public game runner retains wallet connection and fresh owned-NFT eligibility
checks. Label simulated balances and outcomes. Mock accounts and sample Friends
are confined to internal automated fixtures. Keep the sandbox, bridge, child CSP
and public-asset CORS policy.

Browser checks use the package's Playwright dependency and the platform temp
directory. Installing Chromium is a documented setup step.

## CI and acceptance

Run SDK build/tests, typecheck and game validation in a Windows job using the
pinned Node version, without Foundry. Keep contract compilation, ABI verification
and contract tests in the Ubuntu job with Foundry.

Acceptance requires:

- SDK checks passing on Windows without Foundry, with explicit Anvil skip output.
- Manifest permission tests passing with `0600` on POSIX and an owner-only ACL on
  Windows.
- The generic game command serving a playable, ownership-gated component on
  Windows, with simulated actions and all controls inside its frame.
- Browser checks completing without path edits and saving screenshots under
  `os.tmpdir()`.
- Passing Windows SDK and Ubuntu SDK/contract CI jobs.

Scope covers SDK tooling and documentation. Game terms, contract behavior,
transaction permissions and deployment status remain outside this proposal.
No third-party static-server dependency is required.
