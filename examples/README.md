# Example maps

Notes that Mindslate opens as mind maps. Copy this folder (or one note) into your vault: each note has the property
`mindslate: map`, so with the plugin turned on a click opens it as a map. Here on GitHub, and in Obsidian without the
plugin, they are plain outlines.

| Note | What it is | What it shows |
| --- | --- | --- |
| [Sharding](Sharding.md) | study notes on database sharding, 114 nodes | a large map with 8 main branches; labels that run onto a second line |
| [Weekend in Lisbon](Weekend%20in%20Lisbon.md) | a trip plan | a small map to try the keys on; a branch three levels deep |
| [Website Relaunch](Website%20Relaunch.md) | a project plan | `[[links]]`, `#tags`, tasks, a Markdown link, a label that starts with `>` |
| [Team Sync 2026-10-28](Team%20Sync%202026-10-28.md) | meeting notes | properties (`date`, `tags`), people as `[[links]]`, action items as tasks |

Each list item is a node and the `# heading` is the root. A node's second line sits under its first, indented by
two spaces. The map shows `[[links]]`, `#tags` and tasks as text, and in Obsidian they work as they do in any note.

The maps were written with the agent skill's command-line tool
([skills/markdown-mind-map](../skills/markdown-mind-map)), so each one is exactly what the plugin writes for its
tree. An AI agent with the skill makes notes like these from a request, from meeting notes or from an outline.
