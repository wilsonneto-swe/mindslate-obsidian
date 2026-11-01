# Agent skill: markdown-mind-map

This skill teaches an AI agent (Claude Code, the Claude apps, or any agent that reads instructions) to write mind
maps as Markdown notes that Mindslate opens: a `# heading` for the root and a nested `- ` list for the tree. With it,
an agent can turn a request, meeting notes, an outline, a document or JSON into a map in your vault, check a map, or
add to one without breaking it.

In a vault where Mindslate is installed, the agent gives each new map the property `mindslate: map`, so the note
opens as a map as soon as you click it. If the plugin is installed but off, the agent tells you to turn it on.

```
markdown-mind-map/
  SKILL.md              the instructions the agent reads (workflow, writing rules, what makes a good map)
  scripts/mindmap.mjs   the CLI: from-json, from-outline, validate, to-json (one file, Node 18 or later, no dependencies)
  scripts/mindmap.py    the same writer and a lighter validate for agents without Node (Python 3.8 or later)
  reference/FORMAT.md   the complete format rules, with an example for every escape
  examples/             two maps and the JSON each was generated from
```

`mindmap.mjs` is built from Mindslate's own Markdown reader and writer (`core/format/`), so a map it writes is byte
for byte what the plugin writes for the same tree. The skill is not part of the plugin: Obsidian never loads it, and
the plugin's releases (`main.js`, `manifest.json`, `styles.css`) do not include it.

## Install in Claude Code

Claude Code loads skills from `~/.claude/skills/` (every project) and from `.claude/skills/` inside a project (that
project only). Get this repository and copy the folder there:

```
git clone --depth 1 https://github.com/wilsonneto-swe/mindslate-obsidian.git
mkdir -p ~/.claude/skills && cp -R mindslate-obsidian/skills/markdown-mind-map ~/.claude/skills/
```

(Or download the repository as a ZIP from GitHub, under **Code**, and copy `skills/markdown-mind-map` from it.) Start
a new session. Claude uses the skill when a request matches it (a mind map, a brainstorm, a concept map, an outline
to turn into a map); you can also name it: "use the markdown-mind-map skill".

## Install in the Claude apps

Zip the folder (here into your home folder):

```
cd mindslate-obsidian/skills && zip -r ~/markdown-mind-map.zip markdown-mind-map -x '*.DS_Store'
```

Upload the zip as a custom skill in Claude's settings, where skills are managed. The scripts need Claude's code
execution; without it Claude still follows `SKILL.md` and writes the note by hand. A map made there is a file to
download and put in your vault.

## Any other agent

Give the agent `SKILL.md` as instructions (paste it, or point the agent's rules file at it) and keep `scripts/` next
to it if the agent can run commands. It needs Node 18 or later, or Python 3.8 or later for `mindmap.py`.

## Example prompts

- "Make a mind map of the main ideas in this article and save it in my Obsidian vault."
- "Brainstorm a mind map for planning our team offsite, in my vault's Maps folder."
- "Turn these meeting notes into a mind map." (then paste the notes)
- "Add a Risks branch with three risks to Website Relaunch.md."
- "Check Plan a Trip.md: does it open correctly as a mind map?"

## Changes

The skill is developed and tested with the plugin in the repository this one is exported from (the CLI's TypeScript
source and its tests). A pull request here is welcome and ships with the next export.
