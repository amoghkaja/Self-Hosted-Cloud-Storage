import { defineConfig } from 'tsup';

// Bundles our own code (including the workspace shared package) into dist/; third-party
// dependencies stay external and are installed as production node_modules in the image.
export default defineConfig({
  entry: { index: 'src/index.ts', worker: 'src/worker.ts', cli: 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: true,
  sourcemap: true,
  noExternal: [/^@familycloud\//],
  // Migrations ship next to the bundle (see db/client.ts migrationsFolder()).
  onSuccess: 'rm -rf dist/migrations && cp -r src/db/migrations dist/migrations',
});
