# Contributing to Mindslate

Bug reports, ideas and pull requests are all welcome. This page explains how to build the plugin, how to report a
problem so it can be fixed quickly, and what a pull request needs.

## Questions and ideas

Ask in [Discussions](https://github.com/wilsonneto-swe/mindslate-obsidian/discussions): **Q&A** for help, **Ideas**
for what you would like Mindslate to do, **Show and tell** for your maps and setups.
[Issues](https://github.com/wilsonneto-swe/mindslate-obsidian/issues) are for bugs and concrete feature requests.

## Reporting a bug

Open a [bug report](https://github.com/wilsonneto-swe/mindslate-obsidian/issues/new?template=bug_report.yml). A good
one has:

- **Versions**: Mindslate's (Settings > Community plugins) and Obsidian's (Settings > General).
- **Platform**: macOS, Windows, Linux, iOS, iPadOS or Android, and how the vault syncs (Obsidian Sync, iCloud, git,
  another service, or not at all).
- **Steps** from opening the note to the problem, what you expected, and what happened instead.
- **A small note that shows it.** Replace anything personal with placeholder text. When the map changed the note in
  a way it shouldn't have, give the note before and after; if spaces, tabs or line endings matter, attach the files
  rather than pasting them.
- **Errors from the developer console**, if there are any (desktop): View > Toggle Developer Tools (Ctrl+Shift+I, or
  Cmd+Option+I on a Mac), then the Console tab.

## Building and testing

You need Node.js 22.12 or later, and npm.

```
npm install
npm run dev        # main.js and styles.css at the repository root, rebuilt on every change
npm run check      # what every pull request must pass: Obsidian's lint rules, type checks, tests and the build
```

`npm run build`, `npm run lint`, `npm run typecheck` and `npm test` run one step each.

Try your build in a test vault, never in the vault with your real notes. Link the plugin's files into the test vault
once (run this at the repository root):

```
mkdir -p "/path/to/test vault/.obsidian/plugins/mindslate"
for f in main.js manifest.json styles.css; do ln -sf "$PWD/$f" "/path/to/test vault/.obsidian/plugins/mindslate/$f"; done
```

Then enable **Mindslate** in Settings > Community plugins. After each rebuild, run **Reload app without saving** from
the command palette. The maps in [`examples/`](examples) are a quick way to fill the test vault.

## Where things are

- `src/`: the Obsidian plugin: the commands and menus (`main.ts`), the map view (`view.ts`), changes that arrive from
  outside the map (`sync.ts`, `merge.ts`), the `mindslate: map` property and opening flagged notes as maps (`flag.ts`,
  `auto-open.ts`, `patch.ts`), and each map's folds, selection and zoom (`view-state.ts`). Tests sit next to the code
  (`*.test.ts`, run by vitest), with a stand-in for Obsidian's API in `test/fake-obsidian.ts`.
- `core/`: the Mindslate editor the plugin bundles: the Markdown reader and writer (`core/format`, whose rules are in
  [core/format/README.md](core/format/README.md)), the layout, the rendering, and the keyboard and pointer input.
- `skills/`: the agent skill. Its `scripts/mindmap.mjs` is generated from the format code in the development
  repository and `scripts/mindmap.py` is a hand port of the same rules, so don't edit them for a format change:
  change `core/format` and say in the pull request that the skill needs the same change.
- `examples/`: maps to try.

## Sending a pull request

The plugin is developed, with its tests, in a separate repository and exported here for each release. A pull request
here is still welcome: it is reviewed here, and the change ships with the next version.

- Keep each pull request to one change, and say what it fixes or adds and how you tested it (Obsidian version and
  platform).
- `npm run check` passes.
- A change in behaviour comes with a test.
- Maps are people's notes. Opening a note as a map never writes it, an edit rewrites only the lines it touches, and
  nothing the user wrote is lost, not even when the note changes on disk while the map is open (see the format rules
  in [core/format/README.md](core/format/README.md) and the comments at the top of `src/view.ts`).
- Update the README when something a user sees changes.
- No network requests and no telemetry: Mindslate works offline ([Privacy](README.md#privacy)).

By sending a pull request, you agree that your contribution is licensed under the [MIT License](LICENSE).
