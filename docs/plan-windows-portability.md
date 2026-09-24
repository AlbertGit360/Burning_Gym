# Plan: Windows portability for the SDK toolchain

Planned implementation of [Windows portability](intent-windows-portability.md).
Run the acceptance checks before reporting the proposal implemented.

## 1. Portable paths and manifest permissions

In `tests/friend-world.test.mjs`, pass
`fileURLToPath(new URL('../src/friend-world.ts', import.meta.url))` to esbuild.
Keep assertions covering bundle inputs and the absence of `node:fs`.

In `scripts/contracts/common.mjs`, `saveManifest` writes `<path>.tmp` with mode
`0o600`. On Windows, restrict the temporary file before renaming it:

- Implement module-private `restrictToCurrentUser(file)` with promisified
  `execFile`, an argument array, no shell and a ten-second timeout.
- Run `icacls` with `[file, '/inheritance:r', '/grant:r', `${account}:F`]`.
  Use `${process.env.USERDOMAIN}\${username}` when the domain is set, otherwise
  `username`, obtained from `os.userInfo().username`.
- On exit error, spawn failure or timeout, print:
  `Could not restrict <path> to the current Windows account: <short reason>. The manifest contains no private key; review its permissions before sharing it.`
- Continue saving the manifest after an ACL failure. Do not print account names
  or environment contents. Successful restrictions must survive the rename.

Extend the manifest test in `tests/contracts-cli.test.mjs`:

- POSIX: require `mode & 0o777 === 0o600`.
- Windows: run `execFileSync('icacls', [file], { encoding: 'utf8' })`, select
  access-entry lines containing `:(`, strip the first line's file prefix and
  require exactly one full-control entry for the creating user, case-insensitively.
  Require no `(I)` inherited entry. Do not parse localized summary lines.
- Keep base-unit string, private-key exclusion and substituted-RF rejection checks.
- Review the nonfatal ACL-warning path and verify its reported filename.

## 2. Shared Node static server

Provide a reusable `createStaticServer(rootDir)` using `node:http`, shared by the
package game runner and internal browser fixtures. The server must:

- Accept GET and HEAD; return 405 with `Allow: GET, HEAD` otherwise.
- Decode request paths and return 400 on malformed escapes.
- Resolve only under `rootDir`. Reject relative traversal, encoded traversal,
  drive-letter escapes and symlink escapes with 404.
- Serve a directory's `index.html`; return 404 for missing files.
- Include `Cache-Control: no-store` and correct content lengths. HEAD returns no body.
- Preserve sandbox-document CSP and anonymous CORS for public child assets.
- Bind to `127.0.0.1`; support port 0 for internal tests.

Use these content types:

| Extensions | Content type |
| --- | --- |
| `.html` | `text/html; charset=utf-8` |
| `.js`, `.mjs` | `text/javascript` |
| `.css` | `text/css` |
| `.json`, `.map` | `application/json` |
| `.svg` | `image/svg+xml` |
| `.png` | `image/png` |
| `.ico` | `image/x-icon` |
| `.wasm` | `application/wasm` |
| `.txt` | `text/plain; charset=utf-8` |
| Other | `application/octet-stream` |

The generic development runner serves only the selected game's `.friendsdk/`
build, with its verified-ownership runtime. Validate the entry document before
listening and report the build command if it is absent. Validate explicit ports
as integers 1–65535. Report `EADDRINUSE` with a clear alternative-port instruction.
A separate fixture-only server may serve `examples/fishing/dist` on port 4178;
it remains an internal test tool.

Use `fileURLToPath` for script-relative roots and `pathToFileURL` for CLI-entry
comparison. Keep SDK static serving independent of contract tooling imports.

Update browser checks to reuse the server and save screenshots with
`join(tmpdir(), `friendsdk-frame-${width}.png`)`. Keep fixture network allowlists
restricted to their intended local/assets endpoints.

## 3. Server tests

Create a temporary fixture with `index.html`, `demo.js`, `demo.css` and
`sub/index.html`. Listen on port 0 at `127.0.0.1`; close the server and remove the
fixture in `finally`.

| Request | Expected result |
| --- | --- |
| `GET /` | 200, HTML type/body, no-store header |
| `GET /demo.js`, `GET /demo.css` | Correct JavaScript/CSS types |
| `GET /sub/` | Nested index |
| `GET /missing.js` | 404 |
| Raw traversal or encoded traversal | 404; no data outside the fixture |
| `POST /` | 405 and `Allow: GET, HEAD` |
| `HEAD /` | 200, Content-Length, empty body |
| Malformed URL escape | 400 |

Use raw `http.request` for paths normalized by `fetch`. Check CLI startup,
missing-build failure, fixed/explicit ports and occupied-port diagnostics in a
local Windows run.

## 4. Documentation and CI

Document the generic Node game runner in README/example instructions. Public
previews retain real wallet connection and fresh hardwired-NFT eligibility;
sample fixtures are automated test tools. Document manifest access controls
and the warning on restriction failure without describing the records as encrypted.

Add `check-windows` in `.github/workflows/check.yml` with `windows-latest`,
`actions/checkout@v4` (`persist-credentials: false`) and
`actions/setup-node@v4` (Node 22, npm cache). Run `npm ci --ignore-scripts`,
`npm test`, `npm run typecheck` and `npm run check:games`. No Foundry step is required.
The Anvil skip must state `Install Foundry/Anvil to run local contract integration.`
Keep contract build, ABI verification and contract tests in the Ubuntu job.

## Verification and delivery

1. Implement portable URL paths and manifest permissions; run SDK tests on Windows
   and POSIX.
2. Implement shared serving, browser-check reuse and server tests; verify startup,
   path confinement, missing builds, ports and runtime identity gating.
3. Document the final commands, permission rules and browser setup.
4. Run the Windows SDK and Ubuntu SDK/contract CI jobs.

Run `npm test`, `npm run typecheck` and `npm run check:games` on Windows without
Foundry. Install the package browser binary with `npx playwright install chromium`,
then run `npm run check:browser`. Screenshots must land in the platform temp
directory. Run `npm run test:contracts` and `npm run verify:contracts` on the
Foundry-enabled job. No mainnet transaction is part of these checks.

Completion requires passing platform checks, enforced manifest permissions,
confined Node serving, working browser checks and accurate public run instructions.
