// The plugin as Obsidian loads it: main.js (one CommonJS file; `obsidian` is provided by the app) and styles.css, both
// at the repository root, built from src/main.ts and the editor core in core/. Not minified, so the code a vault runs
// stays readable. ES2021 syntax and no Node.js module: the plugin runs on Obsidian's desktop and mobile apps.
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** The class on the map view's element (src/constants.ts VIEW_CLASS). */
const SCOPE = '.mmv-view';
const coreCss = fileURLToPath(new URL('./core/view/editor.css', import.meta.url));

/** Every `.mm-root` rule of the core's stylesheet moves under the view's class: nothing reaches the rest of Obsidian. */
const scopeCoreCss = {
  name: 'mindslate-scope-core-css',
  enforce: 'pre',
  transform(code, id) {
    if (id.split('?')[0] !== coreCss) return null;
    return { code: code.replace(/\.mm-root(?![\w-])/g, `${SCOPE} .mm-root`), map: null };
  },
};

/** main.js and styles.css from build/ to the repository root, where Obsidian and its community directory expect them. */
const toRoot = {
  name: 'mindslate-to-root',
  apply: 'build',
  closeBundle() {
    for (const f of ['main.js', 'styles.css']) {
      copyFileSync(fileURLToPath(new URL(`./build/${f}`, import.meta.url)), fileURLToPath(new URL(`./${f}`, import.meta.url)));
    }
  },
};

export default defineConfig({
  plugins: [scopeCoreCss, toRoot],
  build: {
    outDir: 'build',
    emptyOutDir: true,
    target: 'es2021',
    minify: false,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'main.js',
      cssFileName: 'styles',
    },
    rolldownOptions: {
      external: ['obsidian', 'electron', /^@codemirror\//, /^@lezer\//],
      output: { exports: 'default' },
    },
  },
});
