---
name: markdown-mind-map
description: Writes mind maps as one Markdown file (an H1 root and a TAB-indented "- " list) that opens as a mind map in Mindslate (its desktop and web apps, and the Mindslate plugin inside Obsidian) and reads as a normal note in Obsidian; a bundled CLI turns JSON or an indented outline into a correct file and validates it. Use when the user asks for a mind map, an idea or topic map, a brainstorm, a concept map or a visual outline, or wants notes, an outline, a document or JSON turned into a mind map file for Mindslate or Obsidian (a note that opens as a map with the Mindslate plugin), or wants an existing map of this kind read, checked or edited.
---

# Markdown mind maps (Mindslate)

A mind map is ONE Markdown file: the `# H1` is the root, a nested `- ` list is the tree. Mindslate
(its apps, and its plugin in Obsidian) draws it as a mind map; Obsidian alone shows it as an
ordinary note. Nothing else in the file is part of the map.

`scripts/`, `reference/` and `examples/` are in this skill's folder (`<skill folder>` below: the
folder that holds this SKILL.md). Many agent tools start a new shell for every command, so begin every
command that runs the CLI by setting its full path, then call it as `node "${MM:?}"`, for example
`MM="$HOME/.claude/skills/markdown-mind-map/scripts/mindmap.mjs"; node "${MM:?}" validate "/path/to/vault/<Root>.md"`
(use the real folder). With `MM` empty, `${MM:?}` stops the command with a message; a bare `node ""`
reads a program from standard input instead: it hangs until the tool times out, runs your heredoc as
JavaScript (a SyntaxError), or prints nothing and exits 0, which looks like a passed validate.
validate always prints an outline: no output means the CLI did not run. Give files by their full path
(a bare name lands in the shell's current folder); never `cd` into the skill folder or write maps there.
**Without Node**, set `PY="<skill folder>/scripts/mindmap.py"` the same way and run
`python3 "${PY:?}"` in place of `node "${MM:?}"`: from-json and from-outline write the same bytes,
with the same options; there is no to-json, and its validate is lighter ("Editing an existing map").

## 30-second example

The user asks for a mind map to plan a trip, in their Documents folder. Write the tree as JSON,
then let the CLI write and check the file:

```bash
MM="<skill folder>/scripts/mindmap.mjs"; node "${MM:?}" from-json - -o "$HOME/Documents/Plan a Trip.md" <<'EOF'
{"text": "Plan a Trip", "children": [
  {"text": "Destination", "children": ["Beach or mountains?", "Which season is best to visit?"]},
  {"text": "Local tips", "children": ["Ask a friend who has been there"]},
  {"text": "Trip journal", "children": ["Every evening write down the highlights"]}
]}
EOF
MM="<skill folder>/scripts/mindmap.mjs"; node "${MM:?}" validate "$HOME/Documents/Plan a Trip.md"
```

`Plan a Trip.md` (each level is indented with one TAB):

```markdown
# Plan a Trip

- Destination
	- Beach or mountains?
	- Which season is best to visit?
- Local tips
	- Ask a friend who has been there
- Trip journal
	- Every evening write down the highlights
```

Keep the quotes in `<<'EOF'`: without them the shell expands `$`, backticks and backslashes inside
labels (`$$` becomes a process id, `$1` disappears).

Two complete pairs are in `examples/`: `plan-a-trip.json` → `plan-a-trip.md` (the full version of
the map above) and `website-relaunch.json` → `website-relaunch.md` (line breaks inside labels,
`[[links]]`, `#tags`, tasks, a link and an escaped label).

## Workflow

1. **Plan the tree** before you write anything: the root names the topic, then 3-8 main branches,
   then their children (see "What makes a good map"; for notes or a document, "Turning notes or a
   document into a map").
2. **Write the JSON**: `{"text": "Root", "children": [...]}`. A child is a string (a leaf) or
   `{"text": "...", "children": [...]}`. Put `\n` in a label for a line break inside the node (not in
   the root: the root is one line, and a line break there becomes a space). A branch may add
   `"collapsed": true` to open folded. There are no other keys: a typo or a `"note"` is an error.
3. **Write the map to its destination**, the folder the user named (their Obsidian vault, a project
   folder), else the current folder: `node "${MM:?}" from-json - -o "<folder>/<Root>.md"` with the
   JSON on standard input (a heredoc, as above; in PowerShell or cmd, write the JSON to a file and pass
   its path instead of `-`). The CLI does not create folders: for one that does not exist yet, run
   `mkdir -p "<folder>"` first. Name the file after the root, leaving out `/ \ : * ? " < > | # ^ [ ]`
   (Obsidian refuses some in note names, links break on the others); do not start the name with a
   dot or end it in anything but `.md` (the CLI warns about all three). A JSON file goes in a
   temporary folder and is deleted afterwards: never leave it in the vault. The CLI writes exactly what
   Mindslate writes, escapes included. It never replaces an existing file unless you add
   `--force`: when the file exists, ask the user or use `<Root> 2.md`; use `--force` only on a file
   you wrote in this task. In a vault with Mindslate installed, add `--front-matter 'mindslate: map'`
   (the last section says how to tell).
4. **Validate**: `node "${MM:?}" validate "<folder>/<Root>.md"`. It prints the tree as an indented
   outline: check that it reads the way you meant. Exit 0 = valid (fix the warnings that apply),
   1 = errors, 2 = a bad command line. `--json` gives the same report as JSON.
5. **Tell the user** the file's path, how to open it (last section) and what you had to guess (a mark
   in their notes you read one way, where you put an item they did not place).

Other entry points:

- **An indented outline you already have** (a pasted list; a note organised by headings or a
  paragraph of notes is not one: plan the tree and write JSON):
  - Keep the user's labels as written (wording, case, order: "What makes a good map" is for trees you
    plan, unless they ask you to tidy it), but first remove the marks they did not mean as text: `#`
    headings, `>` quotes, the emphasis and prefixes listed under "Turning notes or a document into a
    map" (`**`, `==`, `$$`, `TODO:`, `->`...), and every line that is only a separator (`---`, `***`,
    `___`). from-outline keeps a mark you leave as label text (it notes only a `#`) and validate does
    not flag it: read the outline it prints for labels that start with a mark.
  - `node "${MM:?}" from-outline - -o "<folder>/<Root>.md"` with the outline on standard input, in a
    heredoc as for JSON (an outline file works too, but never in the vault).
  - One node per non-blank line, nested by indentation only: a line is the child of the nearest line
    above it that sits further left, a TAB counting as 4 columns (if the outline mixes TABs and spaces
    and its TABs meant another depth, re-indent it with spaces; in a heredoc spaces are safest).
    Bullets (`-`, `*`, `+`, `•`) and list numbers counting up from 0 or 1 are dropped; other numbers
    stay ("2026. Plan": `reference/FORMAT.md` section 10). A `#` is dropped on the first line only.
  - The first top-level line is the root and later top-level lines become main branches; with
    `--root "Title"` every top-level line is a branch. Read the notes it prints (the root it chose,
    mixed TABs and spaces, a `#` kept as text) and the outline validate prints.
- **Reading a map:** `node "${MM:?}" to-json "<folder>/<Map>.md"` prints the tree as the JSON above.
- **No runtime at all:** write the file by hand ("Writing the file by hand").

## What makes a good map

- **The root names the topic** in 1-5 words; the file has the same name.
- **3-8 main branches.** Over 12 children under one node is a warning: group them in sub-branches.
- **Short labels: 1-6 words**, one idea per node. Over 80 characters is a warning.
- **Parallel phrasing** among siblings: all nouns ("Budget", "Team") or all actions ("Book the venue").
- **Depth 2-4** for most maps; deeper than 6 levels is a warning.
- **Split long text into children** instead of long labels: a sentence becomes a short parent with
  its key points under it. Use a line break only to keep a label's second line visible (a name and
  a qualifier, a value and its unit).
- **No duplicate siblings** (merge them), **no empty nodes**, and **siblings in a deliberate order**
  (sequence, priority or theme): the map draws them top to bottom.
- **Everything goes in a node.** Text under an item that is not a list item is a note: the file keeps
  it, the map does not show it, and from-json does not write it. **Do not number labels** ("1. Plan").
- `[[wikilinks]]` and `#tags` only when the user works in Obsidian (they link notes and tag the note
  there; on the map they are plain text). A `#word` the user meant otherwise (the Slack channel
  `#general`) tags the note in Obsidian too: keep it and tell the user; reword it ("the general
  channel") only if they do not want the tag (a backslash would show on the map). Tasks
  (`[ ] Call Ana`) only for action items. Inline Markdown (`**bold**`, `[text](https://...)`) stays.
- **Tags and properties of the whole note** (`#launch`, the attendees, a `date:` property) go in front
  matter, never as child nodes and never below the H1 (there Markdown reads it as a rule and a
  heading, and the map disappears): add `--front-matter 'tags: [launch, q3]'` to from-json, once per
  YAML line; the CLI writes the `---` lines above the H1, and validate counts them as canonical.

## Turning notes or a document into a map

Rewrite, do not paste: plan the tree and write JSON (from-outline is for outlines). One idea per node.

- Drop the marks that only structure or emphasise the raw notes, keeping every word that carries
  meaning: `>` quotes, `**`, `$$` or `==` used for emphasis, `TODO:`, `Action:` or `AI:` prefixes,
  list numbers of any value (`1.`, `3.`, `2)`), trailing periods and "...". An arrow between two
  phrases (`->`, `=>`, or `>` as in `total > flights 40%`) goes too: the right side becomes a child or
  the next step. A `>` that means "more than" (`> 1,000 users`) is a word: keep it.
- Keep facts exactly: names, dates, amounts, percentages, counts.
- A title the user gives ("Weekend in Lisbon") is the root and the file name, word for word. Without
  one, a date or period that identifies the meeting or the plan (Q3 2026, 2026-07-15) goes in the root
  and the file name ("Team Sync 2026-07-15"). Dates inside the content (each day of an itinerary, a
  deadline) stay in their nodes as the notes wrote them. As a property a date is `date: 2026-07-15`
  (YYYY-MM-DD), never a bare year; add properties only when the user works in Obsidian or asks.
- Action items become tasks (`[ ] Book the venue`) under one "Action items" branch unless they belong
  to another branch; ordered steps stay plain labels under their own branch, in order.
- Keep `[[links]]`. A `#tag` next to one item (`train 8:11 (#trains)`) stays in that item's label
  (`Train 8:11 #trains`, like `Research #research` in `examples/website-relaunch.md`); only tags that
  label the notes as a whole (a `Tags:` line, tags alone on the first or last line) move to front
  matter (previous section).

## Writing the file by hand

Follow every rule; then show the user the file and, if any tool can run later, validate it.

- Line 1 is `# Root text` (one line), or, when the user wants Obsidian properties, a front matter
  block (`---`, YAML, `---`) comes first and the H1 right after it (`reference/FORMAT.md` section 1).
  The line after the H1 is empty, then the list. Nothing comes after the list, and there is only one
  list.
- Every item is `- ` and its label. Top-level items have no indentation; a child is indented with
  exactly one more TAB than its parent (TABs, never spaces). No blank lines between items.
- A line break inside a label: the next line holds the item's TABs, two spaces, then the text:

```markdown
# Release

- Ship the beta
  to 50 users
	- Collect feedback
	  in one shared doc
```

- One backslash keeps a label that starts like Markdown syntax as plain text. The same rule applies
  to every continuation line:

| A label that starts with | is written | example |
| --- | --- | --- |
| `#` to `######`, then a space or the end of the label | `\#` | `- \# Not a heading`, `- \#` |
| `-`, `*` or `+` and a space (or alone) | `\-`, `\*`, `\+` | `- \- dash` |
| `>` | `\>` | `- \> 1,000 users` |
| a number, then `.` or `)`, then a space or the end of the label | the backslash after the digits | `- 1\. First`, `- 2026\. Plan`, `- 1\.` |
| `%%` or `$$` | `\%%`, `\$$` | `- \%% not a comment` |
| three backticks or `~~~` (a fence) | `\` before it | `- \~~~` |
| `---`, `***`, `___` (a rule), or `--` alone | `\---`, `\***`, `\___`, `\--` | `- \---` |
| `<!--`, a block HTML tag (`<div>`, `<p>`...) or a label that is one tag (`<span>`) | `\<` | `- \<div>`, `- \<span>` |
| `[x]: https://...` (a link definition) | `\[` | `- \[x]: https://e.com` |

  On a continuation line, a line of only `=` or `-` (a heading underline) gets one too: `\=`, `\--`.
  `#tag`, `#1 priority`, `1.5 hours`, `[[Note]]`, `**bold**`, `<b>bold</b> text` and `[ ] task` need no
  backslash (an extra backslash would show in the label). For any other line that starts with
  punctuation, read `reference/FORMAT.md` section 5 first. When in doubt, run validate: it names every
  line that needs a backslash and how to fix it (if it reports a line you meant as a node as part of a
  label, fix that line's indentation instead). An unescaped `%%` matters most: Obsidian hides
  everything after it; two `%%` on one line hide the text between them: reword the label ("percent").
- Do not write empty nodes. (If you must: `-` alone, except the first child of a group, which is
  `- <!-- -->`.)
- UTF-8, LF line endings, one newline at the end of the file.

## Editing an existing map

- Read it first: `node "${MM:?}" validate "<folder>/<Map>.md"` (outline and warnings) or `to-json`.
  Find the item the user names in that outline. Match their wording loosely (case, punctuation); if
  it differs from the label, or two items match, say which one you changed.
- Edit the file in place: change only the list lines you need (add, rename, move or delete items).
  Keep its indentation style (TABs or spaces, `-` or `*` markers: a different marker at the same
  level starts a second list in Obsidian) and its line endings (a line you add to a file with CRLF
  line endings ends with CRLF too; in Python, open the file with `newline=''` or in binary mode: the
  default text mode silently turns every CRLF into LF, so check the endings after saving). Keep
  everything outside the list (front matter, text before or after it) and every note under an item
  byte for byte.
- A new item copies the indentation of its siblings; a child is exactly one TAB deeper than its
  parent. One TAB too many does not make a deeper child: the line becomes part of the parent's label
  (validate says so). Put a new item where the user says, else where it fits the order, or last, and
  always below the whole subtree of the item before it: a new branch "after Rituals" goes below
  Rituals' last child (written right below the "- Rituals" line, it adopts Rituals' children). New
  labels follow the escape rules of "Writing the file by hand".
- A moved item takes its whole subtree (every deeper line below it) along, every line shifted by the
  same number of TABs, its continuation lines (`<TABs>  text`) included.
- Mindslate colours main branches by their position when it opens a file, so a main branch
  inserted or moved before others changes their colours on the map (the file is unaffected): mention
  it when the user asked for no other changes.
- A label that ends with ` <!-- markmap: fold -->` is a folded branch: change the text before the
  comment and keep the comment at the end of the last label line.
- Validate before and after and compare the two outlines line by line: only the items you added,
  renamed, moved or removed may differ, each under the parent you meant, with no new warnings. The
  node count alone does not show an item under the wrong parent.
- `canonical: no` is normal for a map the user wrote: keep their style. If the file was `canonical:
  yes` before your edit and is not after, the line it names is one you wrote: fix it.
- Without Node, `mindmap.py validate` reports what is not canonical in a map the user wrote (text
  around the list, CRLF line endings, notes, spaces or `*` markers) as errors and FAILED: that is not
  damage, do not change their file for it. It prints the tree it read and says where it stops (at a
  note, spaces or `*` markers): compare its reports before and after your edit, and check the lines
  you changed past that point against the rules.
- Do not regenerate a map the user wrote or edited with from-json: that drops their front matter,
  notes and formatting. Use from-json for new maps only.
- A map open in Obsidian (Mindslate plugin) or the desktop app shows a change saved to its file in
  place: edit the file, the user need not close the map.

## How the user opens the result

- **Obsidian with the Mindslate plugin.** The vault is the folder (the map's, or one above it) that
  holds `.obsidian/`; the plugin is installed if `.obsidian/plugins/mindslate/` exists, and on if
  `.obsidian/community-plugins.json` lists `"mindslate"` (else tell the user to turn it on in Settings >
  Community plugins; never edit `.obsidian/` yourself). A note with the property `mindslate: map` opens
  as a map wherever Obsidian opens it (file explorer, links, search): give new maps
  `--front-matter 'mindslate: map'` when the plugin is installed, on or off, and say so (the command
  "Always open this note as a mind map" takes it out). Other notes open as maps with "Open as mind map"
  (command palette, or a right-click on the note). Edits in the map are saved into the note.
- **Obsidian without it:** a normal note, a title with a nested list; `[[links]]` and `#tags` work.
- **Mindslate, desktop app:** File > Open (Cmd+O on macOS, Ctrl+O on Windows), or the system's
  Open With menu on the file. Edits are saved back into the same file.
- **Mindslate, web page:** Open .md (Cmd/Ctrl+O) or drag the file onto the page. In Chrome or
  Edge, "Open and save in place" writes edits back into the file; elsewhere use Download .md.
