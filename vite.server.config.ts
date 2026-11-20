import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: [{ find: 'cloudflare:workers', replacement: resolve(root, 'server/node-env.ts') }] },
  build: {
    ssr: resolve(root, 'server/index.ts'),
    target: 'node24',
    outDir: resolve(root, 'standalone/server'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'index.mjs' } },
  },
  plugins: [{
    name: 'tongzai-standalone-migrations',
    closeBundle() {
      const target = resolve(root, 'standalone/migrations');
      mkdirSync(target, { recursive: true });
      for (const name of readdirSync(resolve(root, 'drizzle')).filter(name => /^\d+.*\.sql$/.test(name))) {
        copyFileSync(resolve(root, 'drizzle', name), resolve(target, name));
      }
    },
  }],
});
