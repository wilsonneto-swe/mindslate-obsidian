// The rules Obsidian's community review applies (eslint-plugin-obsidianmd, recommended), over the plugin: not over
// skills/ (the agent skill, a command-line tool for Node that Obsidian never loads and the plugin does not bundle).
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['main.js', 'styles.css', 'build/**', 'node_modules/**', '*.config.mjs', 'skills/**'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.mjs'] },
      },
    },
  },
]);
