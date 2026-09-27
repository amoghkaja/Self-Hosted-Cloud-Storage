import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Writes .br and .gz next to text assets so the server can send precompressed files (no runtime CPU). */
function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'familycloud-precompress',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((f) => {
          const p = path.join(dir, f);
          return statSync(p).isDirectory() ? walk(p) : [p];
        });
      for (const file of walk(outDir)) {
        if (!/\.(js|css|html|svg|json|webmanifest)$/.test(file)) continue;
        const buf = readFileSync(file);
        if (buf.length < 1024) continue;
        writeFileSync(
          `${file}.br`,
          brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
        );
        writeFileSync(`${file}.gz`, gzipSync(buf, { level: 9 }));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000' },
      '/dav': { target: 'http://localhost:3000' },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 400,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
