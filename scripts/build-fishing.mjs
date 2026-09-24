import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const common = { absWorkingDir: root, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', logLevel: 'warning' };
await build({ ...common, entryPoints: ['examples/fishing/index.tsx'], outfile: 'dist/examples/fishing/index.js', external: ['react', 'react/jsx-runtime'], banner: { js: '"use client";' } });
await build({ ...common, entryPoints: ['examples/fishing/standalone.jsx'], outfile: 'examples/fishing/dist/demo.js', define: { 'process.env.NODE_ENV': '"production"' }, minify: true });
await mkdir(new URL('../examples/fishing/dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../examples/fishing/dist/index.html', import.meta.url), '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FriendSDK · Internal fishing test fixture</title><link rel="stylesheet" href="./demo.css"><style>body{margin:0;background:#f5f3ed}#root{max-width:960px;margin:auto}*{box-sizing:border-box}</style></head><body><main id="root"></main><script type="module" src="./demo.js"></script></body></html>\n');
console.log('Built the shared fishing component and internal standalone test fixture.');
