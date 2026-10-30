// The plugin's unit tests (src/*.test.ts) run in Node. `obsidian` is a types-only package (Obsidian provides the
// module at runtime), so the few values a module imports from it come from a small fake (test/fake-obsidian.ts).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { obsidian: fileURLToPath(new URL('./test/fake-obsidian.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
