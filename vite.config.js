import fs from 'node:fs/promises';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const localCaddyfile = () => ({
  name: 'local-caddyfile',
  configureServer(server) {
    server.middlewares.use('/local-test/Caddyfile', async (_req, res) => {
      try {
        const content = await fs.readFile(path.resolve(process.cwd(), 'Caddyfile'), 'utf8');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(content);
      } catch {
        res.statusCode = 404;
        res.end('Caddyfile not found');
      }
    });
  },
});

export default defineConfig({
  plugins: [react(), localCaddyfile()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
