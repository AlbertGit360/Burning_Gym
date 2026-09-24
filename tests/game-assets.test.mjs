import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

test('game validation accepts creator SVG/PNG art without a world renderer and retains source boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friendsdk custom art '));
  const game = join(directory, 'games/custom-art');
  try {
    await mkdir(game, { recursive: true });
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'examples'));
    await copyFile(join(root, 'scripts/check-games.mjs'), join(directory, 'scripts/check-games.mjs'));
    await copyFile(join(root, 'package.json'), join(directory, 'package.json'));
    // Junctions avoid Windows file-symlink privileges; all fixture writes remain in tmpdir.
    for (const name of ['node_modules', 'dist']) await symlink(join(root, name), join(directory, name), 'junction');
    await copyFile(join(root, 'examples/starter/game.json'), join(game, 'game.json'));
    await writeFile(join(game, 'README.md'), '# Custom artwork validation fixture\n');
    await writeFile(join(game, 'world.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8" fill="purple"/></svg>');
    await writeFile(join(game, 'sprite.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=', 'base64'));
    const component = "import world from './world.svg'; import sprite from './sprite.png'; export default function Game() { return <section><img src={world} alt='Custom world'/><img src={sprite} alt='Custom prop'/></section>; }";
    await writeFile(join(game, 'index.tsx'), component);
    const check = () => exec(process.execPath, [join(directory, 'scripts/check-games.mjs')], { cwd: directory });
    assert.match((await check()).stdout, /games\/custom-art: valid;/);
    assert(!component.includes('GameWorld'));
    // Asset loaders must not permit a game to pull unrelated project artwork into its bundle.
    await writeFile(join(directory, 'outside.svg'), await readFile(join(game, 'world.svg')));
    await writeFile(join(game, 'index.tsx'), component.replace('./world.svg', '../../outside.svg'));
    await assert.rejects(check(), /undeclared source outside the game\/SDK/);
    await writeFile(join(game, 'index.tsx'), "import {createChanceGameTransport} from '@rarefriends/friendsdk/host'; export default () => <p>{String(createChanceGameTransport)}</p>;");
    await assert.rejects(check(), /Wallet transport belongs to the SDK runtime/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
