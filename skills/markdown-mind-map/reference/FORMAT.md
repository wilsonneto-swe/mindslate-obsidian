# The Mindslate mind map format: complete writing rules

SKILL.md has the short version. This file is the full set of rules the app's writer follows, so a
file written by hand comes out exactly like one written by `mindmap.mjs from-json`. Every example on
this page is checked by the CLI's test suite against the real writer.

In the examples a TAB is a real TAB character; `⏎` in the escape lists separates the lines of one
item.

## 1. The file

- One Markdown file, UTF-8 without a byte order mark, LF line endings, one newline at the end.
- In order: an optional front matter block, the `# Root` line, one blank line, the list. Nothing
  after the list.
- Name it after the root: `Trip to Japan.md`, without `/ \ : * ? " < > | # ^ [ ]`.

```markdown
# Trip to Japan

- Cities
	- Tokyo
	- Kyoto
- Budget
	- Flights
	- Hotels
```

- Front matter (Obsidian properties) is allowed above the H1: `---` on the first line, YAML, `---`,
  and the H1 on the next line. The app keeps it byte for byte; it is not part of the map. `from-json`
  and `from-outline` write it with `--front-matter '<YAML line>'` (once per line). Never put it below
  the H1: there Markdown reads the `---` as a rule and the YAML as a paragraph or, closed by `---`, as
  a heading, so the list after it is not the map (validate says so).

```markdown
---
tags: [travel]
---
# Trip to Japan

- Cities
```

## 2. The root

- `# ` and the root text, on one line: line breaks in the root are written as spaces.
- The first H1 of the file is the root. A file without an H1 still opens: its root is the file name
  (`validate` warns).
- A root that ends with a run of `#` after a space gets one backslash before the run, or Markdown
  drops it as a closing sequence:

<!-- root-examples:start -->
```text
"C #"          → # C \#
"#"            → # \#
"C#"           → # C#
"Plan #2"      → # Plan #2
```
<!-- root-examples:end -->

## 3. The list

- The map is the first list after the H1, before any other heading. One list only: a second list, a
  heading or text after it is kept in the file but is not on the map.
- Every item is `- ` and its label. Top-level items have no indentation; a child is indented with one
  TAB more than its parent.
- Tight: no blank lines between items. The app skips them, but Obsidian then draws the list with gaps.
- Mindslate also reads lists written by other tools (`*` or `+` markers, `1.` numbers, two or
  four spaces per level) and keeps their style when it saves. Write the TAB and `- ` form; never mix
  TABs and spaces in one list, and keep one marker among siblings: a `*` item after `-` items (or `1)`
  after `1.`) starts a second list in Obsidian, while the map reads one.
- A child is exactly one TAB deeper than its parent. A line one TAB deeper than that is not a deeper
  child: Markdown and the app read it as more of the parent's label.
- Text right below an item without indentation is NOT separate: Markdown reads it as more of that
  item's label ("lazy continuation"). Put nothing after the list.

## 4. Labels

- The label follows `- ` on the item's line. Spaces and TABs around each line are dropped.
- A line break inside a label: the next line holds the item's TABs, two spaces, then the text. Empty
  lines inside a label are dropped. (`mindmap.mjs` also treats U+2028 / U+2029 as line breaks.)

```markdown
# Line breaks

- First line
  second line
	- A child
	  its second line
```

- A continuation line belongs to its item: when the item moves to another depth, its continuation
  lines move with it (the item's new TABs, then two spaces). One left behind with fewer TABs still
  reads as part of the label (Markdown's lazy continuation), so the map looks right, but the file is
  no longer what the writer writes (validate: `canonical: no`, naming that line).
- Inline Markdown stays as written and Obsidian renders it: `**bold**`, `*italic*`, `` `code` ``,
  `[[Note]]`, `[[Note|alias]]`, `#tag`, `[text](https://example.com)`, tasks `[ ] open` / `[x] done`.
  On the map they show as typed. In Obsidian a `#word` outside code (not only digits) tags the whole
  note, also one meant otherwise (`#general`, a Slack channel); a backslash before it would show on
  the map, so keep it or reword it.

## 5. Escapes

A label line that would start a Markdown block gets exactly ONE backslash, so it stays text. The app
removes exactly one backslash under the same tests when it reads the file, so a label that really
starts with a backslash gets one more. Most escapes go before the line; a list number gets it after
its digits. The tests apply to the first line of a label and to each of its continuation lines.

Escaped on every line:

<!-- escape-examples:start -->
```text
"- not a list"          → - \- not a list
"* star"                → - \* star
"+ plus"                → - \+ plus
"-"                     → - \-
"# Heading"             → - \# Heading
"###### Six"            → - \###### Six
"> quote"               → - \> quote
">"                     → - \>
"```js"                 → - \```js
"~~~"                   → - \~~~
"---"                   → - \---
"***"                   → - \***
"___"                   → - \___
"- - -"                 → - \- - -
"%% not a comment"      → - \%% not a comment
"%%x"                   → - \%%x
"$$ x^2 $$"             → - \$$ x^2 $$
"<div>"                 → - \<div>
"<p>Paragraph"          → - \<p>Paragraph
"<!-- comment -->"      → - \<!-- comment -->
"<script src=x>"        → - \<script src=x>
"| --- |"               → - \| --- |
":--|--:"               → - \:--|--:
"1. First"              → - 1\. First
"1) First"              → - 1\) First
"2026. Plan"            → - 2026\. Plan
"1."                    → - 1\.
"\\# literal"           → - \\# literal
"\\- dash"              → - \\- dash
```
<!-- escape-examples:end -->

Escaped on the first line of a label only:

<!-- escape-examples:start -->
```text
"--"                    → - \--
"<span>"                → - \<span>
"<a href=\"x\">"        → - \<a href="x">
"[x]: https://e.com"    → - \[x]: https://e.com
"x\n[x]: https://e.com" → - x ⏎   [x]: https://e.com
```
<!-- escape-examples:end -->

Escaped on continuation lines only (they would underline the line above as a heading, start a table
or a footnote):

<!-- escape-examples:start -->
```text
"Title\n--"             → - Title ⏎   \--
"Title\n=="             → - Title ⏎   \==
"Title\n="              → - Title ⏎   \=
"Title\n|-|-|"          → - Title ⏎   \|-|-|
"Title\n[^1]: note"     → - Title ⏎   \[^1]: note
```
<!-- escape-examples:end -->

The every-line escapes apply on continuation lines too:

<!-- escape-examples:start -->
```text
"Title\n# h"            → - Title ⏎   \# h
"Title\n1. one"         → - Title ⏎   1\. one
"Title\n%% x"           → - Title ⏎   \%% x
```
<!-- escape-examples:end -->

Not escaped (they start no block):

<!-- escape-examples:start -->
```text
"#tag"                  → - #tag
"#1 priority"           → - #1 priority
"1.5 hours"             → - 1.5 hours
"-x"                    → - -x
"+1"                    → - +1
"**bold** start"        → - **bold** start
"<b>bold</b> text"      → - <b>bold</b> text
"a | b"                 → - a | b
"[ ] task"              → - [ ] task
"[x] done"              → - [x] done
"[[Note]] and #tag"     → - [[Note]] and #tag
"[text](https://e.com)" → - [text](https://e.com)
"x %% y"                → - x %% y
```
<!-- escape-examples:end -->

A label that ends with the fold comment itself (see 7) gets a backslash before it:

<!-- escape-examples:start -->
```text
"x <!-- markmap: fold -->" → - x \<!-- markmap: fold -->
```
<!-- escape-examples:end -->

The `%%` escape matters most: an unescaped `%%` at the start of a line opens an Obsidian comment, and
Obsidian hides everything after it, the rest of the map included. One `%%` inside a label is fine
(`x %% y` above), but two on one line hide the text between them in Obsidian (an inline comment), and
no escape changes that: reword the label (for example write "percent"); validate warns.

## 6. Empty nodes

Avoid them. When one is needed, an empty node is a bare `-`, except the first child of a group,
which is `- <!-- -->` (a bare `-` right below a text line would turn that line into a heading).

<!-- warnings: empty-node, empty-node, empty-node -->
```markdown
# Empty nodes

- <!-- -->
- A branch
	- <!-- -->
	- Second child
	-
```

## 7. Collapsed branches

A branch that should open folded ends its last label line with ` <!-- markmap: fold -->` (the
markmap convention; in JSON: `"collapsed": true`). Obsidian hides the comment. Once a file holds fold
comments, Mindslate writes the collapse state back into it. The comment counts only at the very
end of the label: when you rename a folded branch, change the text before it (anywhere else the map
shows the comment as text and the branch no longer opens folded; validate warns).

```markdown
# Folded

- Details <!-- markmap: fold -->
	- Hidden until expanded
- Visible
```

## 8. What the map does not show

The app keeps all of these in the file, byte for byte, but they are not nodes:

- notes: lines under an item that are not list items or continuation lines (a paragraph after a
  blank line, a code block, a quote);
- anything before the H1 (except front matter) or between the H1 and the list;
- anything after the list: text, a heading, a second list;
- comment lines (`<!-- ... -->`, `%% ... %%`) between items.

A note looks like this (avoid it in new maps: make it a child node instead):

```text
- Budget

  Approved on Monday.
```

## 9. Checking a file

`node "${MM:?}" validate "<folder>/<Map>.md"` (`MM`: the full path of this skill's `scripts/mindmap.mjs`,
set in the same command line, see SKILL.md) reads the file the way the app does and reports:

- errors (exit 1): no list under the H1, with the reason (a heading or a front matter block below the
  H1, a paragraph line right above the list); a failed round trip (a file that mixes CRLF and LF only
  gets a warning: when the app rewrites the list, it uses the file's main line ending throughout);
- warnings: no H1; content the map does not show (section 8); blank lines, comment lines or mixed
  TABs and spaces in the list; a marker that changes among siblings (section 3); label lines that
  need a backslash (section 5); a child indented a TAB too deep, which is read as more of its
  parent's label (section 3); an item whose text starts a block, so the map shows an empty node;
  empty nodes; notes; labels over 80 characters; nodes deeper than 6 levels; more than 12 children
  under one node; duplicate sibling labels; a fold comment that is not at the end of a label
  (section 7); two `%%` on one label line (section 5); mixed CRLF and LF line endings;
- `canonical: yes` when the file is exactly what from-json writes for its tree (after the front matter
  block, when the file starts with one: section 1), else why not: a BOM, CRLF line endings, the first
  line that differs, or a note (from-json writes none).

Messages show a TAB as `\t` and a carriage return as `\r`.

`python3 "<skill folder>/scripts/mindmap.py" validate` (for agents without Node) is lighter: it checks
the canonical form (sections 1-7) and reports everything else as an error, so a map the user wrote
fails it, which is not damage. It still reads such a map as the app does as far as it can: past plain
text before the H1, between the H1 and the list and after the list, with CRLF line endings, and with
a child indented a TAB too deep (shown inside its parent's label, as the app reads it). Where it
cannot follow the file (a note, spaces or `*` markers, a comment line inside the list, a line right
below an item without its indentation, a block above the list it does not read), it stops, names the
line, and says on its `nodes:` line that the outline stops before it (or that the map was not read).
Above that line its outline matches the app's.

`from-json` and `from-outline` refuse a map that is only its root (exit 1, nothing written), as
validate does.

## 10. From an outline (`from-outline`)

`from-outline` makes one node per non-blank line of an indented outline (the rules of the app's paste
for plain outlines):

- Nesting follows the indentation column only: a line is the child of the nearest line above it that
  sits further left. A TAB advances to the next multiple of 4 columns, so where an outline mixes TABs
  and spaces, one TAB is as deep as 4 spaces (the CLI notes the mix): re-indent the outline first if
  its TABs meant another depth. In a heredoc spaces are the safest indentation; the map is written
  with TABs.
- A leading `-`, `*`, `+` or `•` bullet is dropped. A number with `.` or `)` is dropped when it is 0
  or 1, or one more than the number dropped from the sibling above (`1.`, `2.`, `3.` in a row); any
  other number stays in the label, without a note (a list that starts at 2, a gap, `2026. Plan`). A
  rule (`***`, `- - -`, `___`) is not a bullet: it stays as a label.
- The first top-level line is the root (without a leading `#` heading mark); its children and every
  later top-level line become the main branches (the CLI notes the later ones). With `--root "Title"`
  every top-level line is a main branch.
- Everything else is taken literally: a mark stays in the label as text and the writer adds the
  backslash it needs (`> quote` becomes `- \> quote`, `---` becomes `- \---`). The CLI notes a `#`
  heading mark on any line but the root's, but no other mark, and validate does not flag such labels:
  remove the marks the user did not mean as text (quotes, emphasis, separator lines) first.
