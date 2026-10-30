// The rules Obsidian's community review applies (eslint-plugin-obsidianmd, recommended).
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['main.js', 'styles.css', 'build/**', 'node_modules/**', '*.config.mjs'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.mjs'] },
      },
    },
  },
]);
