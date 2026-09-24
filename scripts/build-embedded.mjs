import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
await build({ absWorkingDir: root, entryPoints: ['examples/fishing/embedded.tsx'],
  outfile: 'dist/embed/fishing-frame.mjs', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, minify: true, logLevel: 'warning' });
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src blob: data:; connect-src https://rpc.mainnet.chain.robinhood.com; base-uri 'none'; form-action 'none'; frame-src 'none'";
await writeFile(new URL('../dist/embed/fishing-frame.html', import.meta.url), `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fishing game</title><link rel="stylesheet" crossorigin="anonymous" href="./fishing-frame.css"></head><body><main id="root"></main><script type="module" crossorigin="anonymous" src="./fishing-frame.mjs"></script></body></html>\n`);
const common = { absWorkingDir: root, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', logLevel: 'warning' };
await build({ ...common, entryPoints: ['examples/embedded/index.tsx'], outfile: 'dist/examples/embedded/index.js', external: ['react', 'react/jsx-runtime', '@rarefriends/friendsdk/*'], banner: { js: '"use client";' } });
await build({ ...common, entryPoints: ['examples/embedded/fixture.tsx'], outfile: 'examples/embedded/dist/fixture.js', define: { 'process.env.NODE_ENV': '"production"' }, minify: true });
await mkdir(new URL('../examples/embedded/dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../examples/embedded/dist/index.html', import.meta.url), '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Embedded fishing test fixture</title><link rel="stylesheet" href="./fixture.css"><style>body{margin:0;background:#eee}#root{max-width:960px;margin:auto}*{box-sizing:border-box}</style></head><body><main id="root"></main><script type="module" src="./fixture.js"></script></body></html>\n');
console.log('Built the sandboxed fishing frame, embedded host starter and isolated test fixture.');
