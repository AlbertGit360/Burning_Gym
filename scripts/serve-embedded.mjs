// Explicitly isolated test fixture; mount the exported component in your host for development.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function createEmbeddedFixtureServer() {
  const paths = {
    '/': '../examples/embedded/dist/index.html',
    '/fixture.js': '../examples/embedded/dist/fixture.js',
    '/fixture.css': '../examples/embedded/dist/fixture.css',
    '/embed/fishing-frame.html': '../dist/embed/fishing-frame.html',
    '/embed/fishing-frame.mjs': '../dist/embed/fishing-frame.mjs',
    '/embed/fishing-frame.css': '../dist/embed/fishing-frame.css',
  };
  return createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!Object.hasOwn(paths, path)) { response.writeHead(404).end(); return; }
    try {
      const data = await readFile(new URL(paths[path], import.meta.url));
      response.writeHead(200, {
        'content-type': /\.m?js$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',
        // Opaque sandbox requests have Origin: null; these static assets are public.
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff',
      }).end(data);
    } catch { response.writeHead(500).end('Run npm run build first.'); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createEmbeddedFixtureServer();
  server.listen(4179, '127.0.0.1', () => console.log('Isolated embedded test fixture: http://127.0.0.1:4179'));
}
