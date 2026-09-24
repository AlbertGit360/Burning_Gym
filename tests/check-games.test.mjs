import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sdk = fileURLToPath(new URL('..', import.meta.url));

test('game validation accepts SDK CSS exports but rejects unrelated sources and host imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friendsdk-validator-'));
  try {
    await mkdir(join(root, 'scripts'));
    await copyFile(join(sdk, 'scripts/check-games.mjs'), join(root, 'scripts/check-games.mjs'));
    await copyFile(join(sdk, 'package.json'), join(root, 'package.json'));
    await cp(join(sdk, 'assets'), join(root, 'assets'), { recursive: true });
    for (const directory of ['dist', 'node_modules']) {
      await symlink(join(sdk, directory), join(root, directory), 'dir');
    }
    for (const directory of ['examples/starter', 'examples/fishing', 'games/probe']) {
      await mkdir(join(root, directory), { recursive: true });
      await copyFile(join(sdk, 'examples/fishing/game.json'), join(root, directory, 'game.json'));
      await writeFile(join(root, directory, 'README.md'), 'Internal validation fixture.');
      await writeFile(join(root, directory, 'index.tsx'), 'export default function Game() { return null; }');
    }
    const entry = join(root, 'games/probe/index.tsx');
    const run = () => execFileSync(process.execPath, [join(root, 'scripts/check-games.mjs')], {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    });
    await writeFile(entry, `import '@rarefriends/friendsdk/ui.css';
import '@rarefriends/friendsdk/reveal.css';
import '@rarefriends/friendsdk/frame.css';`);
    assert.match(run(), /games\/probe: valid/);

    await writeFile(join(root, 'private.js'), 'console.log("unrelated source");');
    await writeFile(entry, 'import "../../private.js";');
    assert.throws(run, error => {
      assert.match(error.stderr, /undeclared source outside the game\/SDK: private\.js/);
      return true;
    });

    await writeFile(entry, 'import "@rarefriends/friendsdk/host";');
    assert.throws(run, error => {
      assert.match(error.stderr, /Wallet transport belongs to the SDK runtime, not game code/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
