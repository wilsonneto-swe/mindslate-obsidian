# Format rules (R1-R18)

The reader/writer in this folder implements the refined rules from the format research and the
prototype that passed 71 tests. Tests in `packages/core/test/format` are named after them.

LINEAR: every line test runs in time linear in the line's length. The ones a backtracking regular
expression made quadratic on long crafted lines (R10c's link reference definition, R10f's fold suffix, the
trailing-blank trims, R3's closing `#` sequence, the writer's trims; `escape.ts`, `trim.ts`) are one-pass
scans that accept exactly what the original expressions matched (FZ5 checks them against those
expressions; FZ6 reads 1 MB crafted lines in well under 100 ms).

- **R1 Encoding.** UTF-8. New files: no BOM, LF, exactly one final newline. Existing files: a BOM
  is stripped on read and written back; the EOL is the *majority* line ending (ties: the first
  one), used for every regenerated line; the final newline's presence or absence is kept. A file
  with MIXED line endings: the list region is written with the majority EOL whenever it is
  regenerated (any edit of the map), so the minority endings inside the list are normalised then,
  untouched list lines included; everything outside the region (front matter, intro, postamble)
  keeps its own endings, and a change that leaves the text alone (a collapse in a file without fold
  suffixes) writes nothing.
- **R2 Anatomy.** `[BOM][frontmatter][preamble]'# Root'[intro]<map list>[postamble]`. Only (a) the
  root heading line, when the root text changed, and (b) the map-list region are regenerated;
  every other byte is sliced from the original. Frontmatter exists only when line 1 is `---` and a
  later `---`/`...` closes it; YAML is never parsed.
- **R3 Root.** First top-level H1 (ATX written, setext read) outside opaque blocks and not indented
  inside a list item; closing `#`s stripped; newlines become spaces; a trailing `#` run gets one
  backslash (`C #` -> `C \#`); an empty root is `#`. No H1: the root is virtual (basename) and a
  rename inserts `# text` + blank line after the frontmatter.
- **R4 Map list.** The first top-level list item after the root (or frontmatter) and before the
  next heading (setext underlines included). Right after a paragraph line only a bullet with
  content or an ordered marker starting at 1 can start it. Blank-separated lists are one map. The
  map ends at the first line that belongs to no item; trailing blank lines are postamble.
- **R5 Canonical write.** One item per node, `(d-1)` TABs + `- `, tight list, one blank line after
  the H1. Child indent = parent indent + unit, repeated until it reaches the parent's content
  column; spaces up to that column if the unit overshoots the window.
- **R6 Minimal diffs.** Detect the indent unit (TAB, or the column step between a parent and its
  first nested level as spaces, so an indented top-level list nests new children like the existing
  ones). A sibling group with unchanged membership and order keeps each item's own marker and
  indent, and an unchanged node re-emits its raw lines, including own lines that sit between or
  after its children (each segment goes back right after the child it followed, so an edit
  elsewhere never reorders such an item's paragraphs); a touched group is normalised (first item's
  indent if still valid, first item's bullet or delimiter, sequential numbers). Every node keeps
  its leading trivia; a new node copies the blank-line count of the sibling written before it. A node
  whose text (or fold suffix, or number) changed while its columns did not (same indent column, same
  content column) writes only its new text lines: its own lines after the text (its note, tab-indented
  or not, blank lines, code) go out verbatim, and so do the lines that followed its children (R8).
- **R7 Multi-line text.** Continuation lines = item indent + marker width + 1 spaces (Obsidian's
  Shift+Enter). Lines are trimmed of spaces/tabs and empty lines dropped on write; never wrapped.
- **R8 Reading text.** The item's first paragraph (indented and lazy continuation lines included),
  trimmed, fold suffix stripped, unescaped, joined with `\n`. A marker line that starts a
  non-paragraph block gives empty text + body. Other content (after a blank line, interrupting
  blocks, content after the children, a `%%…%%` / `$$…$$` / `<!--…-->` block indented to the
  item's content column) is raw `body`, dedented by the content column. An item that keeps its
  columns re-emits its own lines after its text verbatim (R6), and the lines that followed a child go
  back right after that child while the children group is untouched. An item written at another
  content column (moved to another depth, a number that grew a digit) gets its body re-indented to
  the new column, after the text and before the children; when some of its own lines had followed a
  child, its children group is then normalised to one indent, since a child indented deeper than the
  one before it was its sibling only because such a paragraph closed that one (written before the
  children, the paragraph would no longer separate them). A regenerated body whose first line would
  continue the text's paragraph (a plain line, indented code, a link reference definition, a
  setext-looking line) gets a blank line first, so text and body read back apart. An ordered marker
  with N != 1 met while the item's paragraph is open is continuation text (CommonMark 5.2).
- **R9 Raw inline Markdown.** Node text is never escaped except under R10; task prefixes stay raw.
- **R10 Escaping (per line).** (a) `^(\d+)(\\*)([.)])([ \t]|$)`: one backslash after the digits
  (any digit count). (b) Otherwise one backslash before a line that would start a bullet, ATX
  heading, quote, fence, thematic break, HTML block 1-6, table delimiter row, delimiter-only row,
  or `%%`/`$$`. (c) First line also: a lone complete tag (HTML 7), a link reference definition, a
  dash run under `-` or a star run under `*`. (d) Continuation lines also: setext underlines,
  table delimiter rows, footnote definitions. (e) The reader removes exactly one backslash under
  the same tests (bijective). (f) A literal `<!-- markmap: fold -->` suffix gets one backslash;
  a backslash-free suffix means collapsed.
- **R11.** Leading/trailing spaces and tabs in node text cannot be represented: trimmed on commit.
- **R12 Empty node.** A bare marker, except: the first item of its group at any depth, and an item
  whose first child is preceded by a blank line, are written `- <!-- -->` (a bare marker there is a
  setext underline, or an empty item that CommonMark closes before the children). The reader maps
  `<!-- -->` to empty text; a hand-typed bare `-` is read as an empty child and only rewritten when
  its lines are regenerated.
- **R13 Ordered groups** keep their delimiter; a regenerated group is numbered from 1 unless a
  blank line precedes its first item (then the original start is kept); a new sibling takes the
  next number.
- **R14 Region changes.** Deleting the last node removes the region and collapses the blank lines
  around it. The first node of a file without a list goes after the intro section (or the H1) as
  EOL EOL list, plus one blank line when non-blank content follows (a whole blank line when the
  list lands at the very start of the body, right before a heading line; the H1 inserted for a
  renamed virtual root never adds a second blank line). An empty or whitespace-only file becomes
  `# <basename>` EOL EOL list EOL.
- **R15 Lazy-continuation guard.** If the line after the region is non-blank and not a block
  start, one EOL is inserted after the region.
- **R16 Trivia.** Blank lines and line-start `%%…%%` / `$$…$$` / `<!--…-->` blocks between items
  (at the top level, or at the indent of the nested items they sit between) are leading trivia of
  the following node: emitted verbatim, moved and deleted with it. A block indented to an open
  item's content column is that item's body instead (R8): every Markdown parser renders it inside
  the item, and as trivia it would vanish with the next sibling. A block right above the item that
  becomes an item's FIRST child (at that child's column or deeper; blank lines and other such blocks
  may sit in between) is that child's trivia too, exactly as above any later child: a comment written
  above a node stays with the node when it lands first in a group (a drag, Alt+Enter) instead of
  turning into the parent's note. Refined (`serialize.ts` `leadingTrivia`): the blank lines before
  the FIRST item of a group separate the list from the parent's text or note, so they belong to that
  slot: whichever node is first now gets the parsed first item's blank lines, and a node that was
  first and moves to a later position takes the group's spacing between items (its tightest), so a
  reorder, a move, an Alt+Enter wrapper or a new first item never turns a tight list loose. A new
  item copies the blank lines written before the item before it, or right after the first item the
  group's spacing. A comment block in the trivia always travels with its node, with the blank lines
  between it and the item; written before an item at another column than it was parsed at (moved
  to another depth, re-indented under a renumbered parent) its lines move to the item's new indent:
  left at the old column the comment would close the items between the two columns and the items
  after it would be read (and rendered by Obsidian) under another parent.
- **R17 Write policy** lives in the desktop file layer (see docs/ARCHITECTURE.md).
- **R18 Parser.** A line-based scanner following CommonMark container rules (tab stops of 4,
  content column = marker + 1-4 spaces else marker + 1, lazy continuation, fences in bodies, a
  paragraph never starts at indent 4+); no dependencies. Neither the reader nor the writer
  recurses on the tree depth (explicit stacks), so a file nested thousands of levels deep never
  throws. The optional markdown-it cross-check runs when markdown-it is installed at the repo
  root.

## Port notes (immutable editor)

- Nodes are frozen `{ text, children, collapsed?, body? }`; provenance (raw lines, marker, indent,
  trivia, parsed children) lives in `MapDocument.provenance`, keyed by node identity, never on the
  nodes. `serializeDocument(doc, root)` returns the input unchanged when `root === doc.root`.
- Children are matched to the parsed children by identity, then by LINEAGE when the editor passes
  `SerializeOptions.keyOf` (its stable node ids: a path copy keeps the id of the object it replaces,
  so the writer pairs every node with the parsed node it descends from wherever it is now, and a
  keyed node whose key no parsed node has is new and is never paired by a guess), then as spread
  copies (a kid that holds a parsed child's frozen `children` array is that child edited in place),
  then as a 2b claim (a kid holding some of a parsed sibling's children, unless its own text names
  another unused sibling: a child dragged from X into Y leaves Y being Y), then by text inside the
  gaps between those anchors when that text occurs exactly once among the gap's kids and once among
  its parsed children, then by position when a gap has the same number of items left
  (`pairing.ts`). A parsed node that is present elsewhere in the tree (moved away, by identity or by
  key) is never guessed for another kid, so its trivia and raw lines are never written twice. The
  matching is linear in the group size (hash maps, no LCS), so there is no sibling-count cliff. A
  wrong match can only change style hints (marker, indent, blank lines) and which raw lines are
  reused, never text: the one thing a match carries is a `body` the editor did not model. An
  identity, lineage or copy match always carries it; a 2b claim never does; a unique-text match
  carries it only in a tree rebuilt from scratch (no parsed node identity survives anywhere and no
  keys: an editor that does not model bodies), and so does a positional match whose text is
  unchanged (the same node in the same place: an unchanged save must not strip two `[ ] task`
  siblings of their notes); in an identity-preserving tree a key-less node is a new node and never
  takes a sibling's body, so two '' nodes (one deleted, one just created) never swap, duplicate or
  resurrect a note. A positional match with a changed text never carries a body. Residual for
  rebuilt trees: deleting one of two same-text siblings cannot be matched (the counts differ), so the
  survivor's body is dropped. Without keys the guesses cannot tell apart two same-text siblings that
  were edited inside and reordered (their notes are re-indented, never lost): the editor passes its
  ids (`model/document.ts` `writeDocument`), and with them every node that keeps its text and its
  depth re-emits its own lines byte for byte, whatever was edited, moved or reordered around it.
- So the editor Node MUST carry `body?: string` and build nodes by spreading the parsed node
  (`{ ...node, text }`), through every copy path (mkNode / patch / cloneTree in the web demo being
  ported), never `{ text, children }` only: in an identity-preserving editor a node without a
  `body` key has no body. The identity suite has a 1000-sibling test for the fully rebuilt
  (demo-shaped) case: byte-identical when unchanged (same-text siblings included), one note lost
  per demo-shaped text edit.
- A node whose text is emptied while it has a paragraph body is written `- <!-- -->` + body, so the
  paragraph is read back as `body`, not promoted to the node text (ED19).
