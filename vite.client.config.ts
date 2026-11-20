import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const project = path.dirname(fileURLToPath(import.meta.url));
const prefix = (process.env.APP_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '');

export default defineConfig({
  root: path.join(project, 'standalone-src'),
  base: prefix ? `/${prefix}/` : '/',
  publicDir: path.join(project, 'public'),
  plugins: [react()],
  resolve: { alias: { '@': project } },
  build: { outDir: path.join(project, 'standalone/client'), emptyOutDir: true },
});
