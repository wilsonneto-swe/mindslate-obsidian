#!/usr/bin/env python3
"""mindmap.py: the Python fallback of mindmap.mjs, for agents that have Python 3.8+ but no Node.

    python3 mindmap.py from-json <file.json|-> [-o out.md] [--front-matter <yaml>]... [--force]
    python3 mindmap.py from-outline <file.txt|-> [--root "Title"] [-o out.md] [--front-matter <yaml>]... [--force]
    python3 mindmap.py validate <file.md|->

from-json and from-outline write the same bytes as `node mindmap.mjs` (the Mindslate writer): the
escapes, continuation lines and empty-node rules below are a line-for-line port of the app's format code
(packages/core/src/format in the Mindslate repository), with JavaScript's regular-expression
semantics kept where Python's differ (JavaScript \\s and '.', ASCII-only \\d, \\w and case folding).
validate is lighter than the Node one: it checks the canonical form (an optional front matter block, '# Root',
one blank line, a TAB-indented '- ' list) and reports anything else as an error, with the line. It reads on past
plain text before the H1, between the H1 and the list and after the list, and says where it stops reading a list
it does not follow (notes, spaces or '*' markers), so the outline it prints is never silently partial.
LINEAR: as in the app's format code, every test of a line runs in time linear in its length: the link reference
definition test, the fold suffix, the root's line breaks and an H1's closing hashes are hand-written scans, not
expressions that backtrack over a long line.
Exit codes: 0 ok (warnings allowed), 1 errors, 2 usage. No dependencies.
"""
from __future__ import annotations

import json
import re
import sys
from array import array

VERSION = '0.1.0'
MAX_DEPTH = 200
LIMIT_LABEL = 80
LIMIT_DEPTH = 6
LIMIT_CHILDREN = 12
FOLD = '<!-- markmap: fold -->'
OUTLINE_LINES = 400

# JavaScript's \s (WhiteSpace + LineTerminator), its '.' (anything but a line terminator) and trim().
_WS = '\\t\\n\\x0b\\x0c\\r \\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'
_DOT = '[^\\n\\r\\u2028\\u2029]'
_TRIM = ('\t\n\x0b\x0c\r \xa0\u1680' + ''.join(chr(c) for c in range(0x2000, 0x200B))
         + '\u2028\u2029\u202f\u205f\u3000\ufeff')


def js_trim(s: str) -> str:
    return s.strip(_TRIM)


# --- R10: line-start escapes (packages/core/src/format/escape.ts) ---------------------------------
_HTML6 = ('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|'
          'dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|'
          'hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|'
          'search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul')
RE_BULLET = re.compile(r'[-+*](?:[ \t]|\Z)')
RE_ATX = re.compile(r'#{1,6}(?:[ \t]|\Z)')
RE_QUOTE = re.compile(r'>')
RE_FENCE = re.compile(r'(?:`{3,}|~{3,})')
RE_THEMATIC = re.compile(r'(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})\Z')
RE_DASH_RUN = re.compile(r'-(?:[ \t]*-)+[ \t]*\Z')
RE_STAR_RUN = re.compile(r'\*(?:[ \t]*\*)+[ \t]*\Z')
RE_HTML1TO6 = re.compile(r'(?:<(?:script|pre|style|textarea)(?:[ \t>]|\Z)|<!--|<\?|<![A-Za-z]|<!\[CDATA\[|</?(?:'
                         + _HTML6 + r')(?:[ \t>]|/>|\Z))', re.I | re.A)
RE_HTML7 = re.compile(r'''(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*'''
                      r'''(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*/?>|</[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*\Z''')
RE_SETEXT = re.compile(r'(?:=+|-+)[ \t]*\Z')
RE_TABLE_DELIM_PREFIX = re.compile(r'\|?[ \t]*:?-+:?[ \t]*\|')
RE_DELIM_ONLY = re.compile(r'(?=[^|]*\|)(?=[^-]*-)[-:| \t]+\Z')
RE_FOOTNOTE_DEF = re.compile(r'\[\^[^\]' + _WS + r']+\]:')
RE_TABLE_DELIM = re.compile(r'(?=' + _DOT + r'*\|)\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*\Z'
                            r'|:?-+:?[ \t]*\|[ \t]*:?-+:?')
RE_OBS_BLOCK = re.compile(r'(?:%%|\$\$)')
RE_ORDERED = re.compile(r'([0-9]+)(\\*)([.)])(' + _DOT + r'*)\Z')
RE_FOLD_TAIL = re.compile(r'<!--[ \t]*markmap:[ \t]*fold(?:All)?[ \t]*-->[ \t]*\Z')
RE_ROOT_HASHES = re.compile(r'(^|[ \t])(\\*)(#+)\Z')
RE_ROOT_HASHES_ESCAPED = re.compile(r'(^|[ \t])\\(\\*)(#+)\Z')
RE_WS_RUN = re.compile('[' + _WS + ']+')
RE_SURROGATE = re.compile('[\ud800-\udfff]')


# JavaScript's \s and its line terminators, on UTF-16 code units (escape.ts isSpace, isLineTerminator)
_SPACE_UNITS = frozenset([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
                          0xfeff] + list(range(0x2000, 0x200b)))
_LINE_TERMINATOR_UNITS = frozenset([0x0a, 0x0d, 0x2028, 0x2029])


def _utf16_units(s: str):
    a = array('H')
    a.frombytes(s.encode('utf-16-le', 'surrogatepass'))
    if sys.byteorder == 'big':
        a.byteswap()
    return a


def link_def_start(s: str) -> bool:
    """R10c: does s start like a link reference definition, "[label]:"? Exactly the lines that JavaScript's
    /^\\[(?:[^\\]\\\\]|\\\\.)*\\S(?:[^\\]\\\\]|\\\\.)*\\]:/ matches (escape.ts linkDefStart, on UTF-16 code units as
    JavaScript reads them), in one pass: the states are the ways it could match so far (LINEAR)."""
    if not s.startswith('['):
        return False
    a, a_esc, b, b_esc = 1, 2, 4, 8
    u = _utf16_units(s)
    st = a
    for i in range(1, len(u)):
        c = u[i]
        if st & b and c == 0x5d and i + 1 < len(u) and u[i + 1] == 0x3a:
            return True
        plain = c != 0x5d and c != 0x5c
        nxt = 0
        if st & a:
            if plain:
                nxt |= a
            elif c == 0x5c:
                nxt |= a_esc
            if c not in _SPACE_UNITS:
                nxt |= b
        if st & a_esc and c not in _LINE_TERMINATOR_UNITS:
            nxt |= a
        if st & b:
            if plain:
                nxt |= b
            elif c == 0x5c:
                nxt |= b_esc
        if st & b_esc and c not in _LINE_TERMINATOR_UNITS:
            nxt |= b
        if nxt == 0:
            return False
        st = nxt
    return False


def fold_suffix(line: str):
    """The fold suffix of a line: (where it starts, its backslashes included; how many backslashes), or None. What
    /(\\\\*)<!--[ \\t]*markmap:[ \\t]*fold(?:All)?[ \\t]*-->[ \\t]*$/ finds, without its scan from every backslash of a
    long run (LINEAR): the comment runs to the end and holds no "<" after its first, so it starts at the last "<!--"."""
    lt = line.rfind('<!--')
    if lt < 0 or not RE_FOLD_TAIL.match(line, lt):
        return None
    at = lt
    while at > 0 and line[at - 1] == '\\':
        at -= 1
    return at, lt - at


def trim_closing_hashes(s: str) -> str:
    """An ATX heading's text without its closing sequence: what /(?:^|[ \\t]+)#+[ \\t]*$/ removes (LINEAR)."""
    t = len(s)
    while t > 0 and s[t - 1] in ' \t':
        t -= 1
    h = t
    while h > 0 and s[h - 1] == '#':
        h -= 1
    if h == t:
        return s
    if h == 0:
        return ''
    if s[h - 1] not in ' \t':
        return s
    b = h
    while b > 0 and s[b - 1] in ' \t':
        b -= 1
    return s[:b]


def _leading_backslashes(s: str) -> int:
    k = 0
    while k < len(s) and s[k] == '\\':
        k += 1
    return k


def _needs_prepend(s: str, first: bool, bullet_char) -> bool:
    if (RE_BULLET.match(s) or RE_ATX.match(s) or RE_QUOTE.match(s) or RE_FENCE.match(s)
            or RE_THEMATIC.match(s) or RE_HTML1TO6.match(s) or RE_TABLE_DELIM_PREFIX.match(s)
            or RE_DELIM_ONLY.match(s) or RE_OBS_BLOCK.match(s)):
        return True
    if first:
        return bool((bullet_char == '-' and RE_DASH_RUN.match(s)) or (bullet_char == '*' and RE_STAR_RUN.match(s))
                    or RE_HTML7.match(s) or link_def_start(s))
    return bool(RE_SETEXT.match(s) or RE_TABLE_DELIM.match(s) or RE_FOOTNOTE_DEF.match(s))


def _ordered_block(rest: str) -> bool:
    return rest == '' or rest[0] in ' \t'


def escape_line(line: str, first: bool, bullet_char='-') -> str:
    m = RE_ORDERED.match(line)
    if m and _ordered_block(m.group(4)):
        return m.group(1) + '\\' + m.group(2) + m.group(3) + m.group(4)
    k = _leading_backslashes(line)
    return '\\' + line if _needs_prepend(line[k:], first, bullet_char) else line


def unescape_line(line: str, first: bool, bullet_char='-') -> str:
    m = RE_ORDERED.match(line)
    if m and len(m.group(2)) >= 1 and _ordered_block(m.group(4)):
        return m.group(1) + m.group(2)[1:] + m.group(3) + m.group(4)
    k = _leading_backslashes(line)
    return line[1:] if k >= 1 and _needs_prepend(line[k:], first, bullet_char) else line


def escape_fold_suffix(line: str) -> str:
    f = fold_suffix(line)
    return line[:f[0]] + '\\' + line[f[0]:] if f else line


def escape_root(text: str) -> str:
    # each run of white space that holds a line break becomes one space (/\\s*\\n\\s*/g in one pass: LINEAR)
    s = js_trim(RE_WS_RUN.sub(lambda m: ' ' if '\n' in m.group(0) else m.group(0), text))
    m = RE_ROOT_HASHES.search(s)
    return s[:m.start() + len(m.group(1))] + '\\' + m.group(2) + m.group(3) if m else s


def unescape_root(s: str) -> str:
    m = RE_ROOT_HASHES_ESCAPED.search(s)
    return s[:m.start() + len(m.group(1))] + m.group(2) + m.group(3) if m else s


def heading_line(root_text: str) -> str:
    esc = escape_root(root_text)
    return '# ' + esc if esc else '#'


# --- R7/R11: texts as the app stores them ----------------------------------------------------------
def normalize_text(text: str) -> list:
    return [s for s in (x.strip(' \t') for x in re.sub(r'\r\n?', '\n', text).split('\n')) if s != '']


def _separators_to_breaks(raw: str) -> str:
    # U+2028 / U+2029 count as line breaks (see normalizeLabel in mindmap.mjs: the app's escape test misses them).
    return raw.replace('\u2028', '\n').replace('\u2029', '\n')


def normalize_label(raw: str) -> str:
    return '\n'.join(normalize_text(_separators_to_breaks(raw)))


def normalize_root(raw: str) -> str:
    return js_trim(' '.join(normalize_text(_separators_to_breaks(raw))))


# --- The canonical writer (R1, R5, R7, R10, R10f, R12, R14 for a brand-new file) ----------------------
class Node:
    __slots__ = ('text', 'children', 'collapsed', 'line')

    def __init__(self, text: str, children=None, collapsed=False, line=0):
        self.text = text
        self.children = children if children is not None else []
        self.collapsed = bool(collapsed and self.children)
        self.line = line


def _emit(nodes, depth: int, out: list) -> None:
    indent = '\t' * depth
    for i, n in enumerate(nodes):
        esc = [escape_line(l, j == 0, '-') for j, l in enumerate(normalize_text(n.text))]
        if esc:
            esc[-1] = escape_fold_suffix(esc[-1])
        if n.collapsed:
            if esc:
                esc[-1] = esc[-1] + ' ' + FOLD
            else:
                esc.append(FOLD)
        if esc:
            first = ' ' + esc[0]
        else:
            first = ' <!-- -->' if i == 0 else ''
        out.append(indent + '-' + first)
        for l in esc[1:]:
            out.append(indent + '  ' + l)
        _emit(n.children, depth + 1, out)


def write_map(root: Node) -> str:
    """The file Mindslate writes for this tree: '# Root', a blank line, the list, LF, one final newline."""
    head = heading_line(root.text)
    if not root.children:
        return head + '\n'
    out = []
    _emit(root.children, 0, out)
    return head + '\n\n' + '\n'.join(out) + '\n'


# --- Input --------------------------------------------------------------------------------------------
class InputError(Exception):
    pass


def _describe(v) -> str:
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'a boolean'
    if isinstance(v, (int, float)):
        return 'a number'
    if isinstance(v, str):
        return 'a string'
    if isinstance(v, list):
        return 'an array'
    return 'an object'


def _text(v, where: str) -> str:
    if not isinstance(v, str):
        raise InputError('%s must be a string, not %s' % (where, _describe(v)))
    if RE_SURROGATE.search(v):
        raise InputError('%s holds an invalid character (a lone UTF-16 surrogate)' % where)
    return v


def _children(v, where: str) -> list:
    if v is None:
        return []
    if not isinstance(v, list):
        raise InputError('%s must be an array, not %s' % (where, _describe(v)))
    return v


def _check_keys(o: dict, allowed, where: str) -> None:
    for k in o:
        if k in allowed:
            continue
        if k in ('note', 'notes'):
            raise InputError('%s: "%s" is not supported: the map shows no notes; put that text into child nodes' % (where, k))
        raise InputError('%s: unknown key "%s" (allowed: %s)' % (where, k, ', '.join('"%s"' % a for a in allowed)))


def _child(v, where: str, depth: int) -> Node:
    if depth > MAX_DEPTH:
        raise InputError('the tree is deeper than %d levels (at %s)' % (MAX_DEPTH, where))
    if isinstance(v, str):
        return Node(normalize_label(_text(v, where)))
    if not isinstance(v, dict):
        raise InputError('%s must be a string or an object with "text", not %s' % (where, _describe(v)))
    _check_keys(v, ('text', 'children', 'collapsed'), where)
    if 'text' not in v:
        raise InputError('%s has no "text"' % where)
    label = normalize_label(_text(v['text'], where + '.text'))
    collapsed = v.get('collapsed')
    if collapsed is not None and not isinstance(collapsed, bool):
        raise InputError('%s.collapsed must be true or false, not %s' % (where, _describe(collapsed)))
    if 'collapsed' in v and collapsed is None:
        raise InputError('%s.collapsed must be true or false, not null' % where)
    kids = [_child(c, '%s.children[%d]' % (where, i), depth + 1)
            for i, c in enumerate(_children(v.get('children'), where + '.children'))]
    return Node(label, kids, collapsed is True)


def _no_constants(name):
    raise ValueError('%s is not JSON' % name)


def tree_from_json(source: str) -> Node:
    try:
        data = json.loads(strip_bom(source), parse_constant=_no_constants)
    except (ValueError, RecursionError) as e:
        raise InputError('not valid JSON: %s' % e)
    if not isinstance(data, dict):
        raise InputError('expected a JSON object like {"text": "Root", "children": [...]}, not %s' % _describe(data))
    _check_keys(data, ('text', 'root', 'children'), 'the top level')
    if 'text' in data and 'root' in data:
        raise InputError('give the root as "text" or as "root", not both')
    key = 'root' if 'root' in data else 'text'
    if key not in data:
        raise InputError('the top level has no "text" (the root of the map)')
    root = normalize_root(_text(data[key], key))
    if root == '':
        raise InputError('the root ("%s") is empty: name the topic of the map' % key)
    kids = [_child(c, 'children[%d]' % i, 1) for i, c in enumerate(_children(data.get('children'), 'children'))]
    return Node(root, kids)


def front_matter_block(values) -> str:
    """--front-matter (see src/front-matter.ts in mindmap.mjs): Obsidian properties above the H1. Each value is one
    or more YAML lines, written as given between the '---' lines the CLI adds; a '---' given first or last is dropped,
    one in between is refused, and so is a TAB at the start of a line (YAML indents with spaces)."""
    lines = [l.rstrip(' \t') for v in values for l in re.sub(r'\r\n?', '\n', v).split('\n')]

    def trim():
        while lines and lines[0] == '':
            lines.pop(0)
        while lines and lines[-1] == '':
            lines.pop()
    trim()
    if lines and lines[0] == '---':
        lines.pop(0)
    if lines and lines[-1] == '---':
        lines.pop()
    trim()
    if not lines:
        raise InputError("--front-matter is empty: give the YAML lines of the properties, for example "
                         "--front-matter 'tags: [launch, q3]'")
    for l in lines:
        if RE_SURROGATE.search(l):
            raise InputError('--front-matter holds an invalid character (a lone UTF-16 surrogate)')
        if l in ('---', '...'):
            raise InputError('--front-matter: a "%s" line would end the front matter early; give only the YAML lines '
                             '(the CLI writes the "---" lines)' % l)
        if l.startswith('\t'):
            raise InputError('--front-matter: YAML indents with spaces, not TABs (%s)' % _q(l))
    return '---\n' + '\n'.join(lines) + '\n---\n'


def lead(text: str):
    """(column, length, rest): leading spaces and tabs, a tab advancing to the next multiple of 4."""
    col = 0
    i = 0
    while i < len(text):
        c = text[i]
        if c == ' ':
            col += 1
        elif c == '\t':
            col += 4 - (col % 4)
        else:
            break
        i += 1
    return col, i, text[i:]


def split_lines(text: str) -> list:
    if text == '':
        return []
    parts = text.split('\n')
    if text.endswith('\n'):
        parts.pop()
    return [p[:-1] if p.endswith('\r') else p for p in parts]


def strip_bom(text: str) -> str:
    return text[1:] if text.startswith('\ufeff') else text


_MARK = re.compile('([-+*•]|([0-9]{1,9})([.)]))(?=[ \\t]|\\Z)')
_HEADING = re.compile(r'#{1,6}(?:[ \t]+|\Z)')


def tree_from_outline(source: str, root_option=None):
    """One node per non-blank line, nested by indentation; see mindmap.mjs (src/input-outline.ts)."""
    notes = []
    top = {'col': -1, 'line': 0, 'text': '', 'num': None, 'kids': []}
    stack = [top]
    tabbed = spaced = 0
    heading_lines = []
    for index, line in enumerate(split_lines(strip_bom(source))):
        col, width, rest = lead(line)
        if js_trim(rest) == '':
            continue
        ws = line[:width]
        if '\t' in ws:
            tabbed += 1
        if ' ' in ws:
            spaced += 1
        while len(stack) > 1 and stack[-1]['col'] >= col:
            stack.pop()
        parent = stack[-1]
        prev = parent['kids'][-1] if parent['kids'] else None
        text = rest
        num = None
        m = None if RE_THEMATIC.match(rest) else _MARK.match(rest)
        if m:
            content = rest[len(m.group(1)):].lstrip(' \t')
            if m.group(2) is None:
                text = content
            else:
                k = int(m.group(2))
                if k <= 1 or (prev is not None and prev['num'] is not None and prev['col'] == col and prev['num'] + 1 == k):
                    text = content
                    num = k
        text = text.rstrip(' \t')
        if _HEADING.match(text):
            heading_lines.append(index + 1)
        item = {'col': col, 'line': index + 1, 'text': text, 'num': num, 'kids': []}
        parent['kids'].append(item)
        stack.append(item)
        level = len(stack) - 2 if root_option is None and stack[1] is top['kids'][0] else len(stack) - 1
        if level > MAX_DEPTH:
            raise InputError('the outline is deeper than %d levels (line %d)' % (MAX_DEPTH, index + 1))
    if not top['kids']:
        raise InputError('the outline is empty')
    first = top['kids'][0]
    if root_option is not None:
        if RE_SURROGATE.search(root_option):
            raise InputError('--root holds an invalid character (a lone UTF-16 surrogate)')
        root_text = root_option
        branches = top['kids']
    else:
        root_text = first['text']
        h = _HEADING.match(root_text)
        if h:
            root_text = trim_closing_hashes(root_text[h.end():]).rstrip(' \t')
        branches = first['kids'] + top['kids'][1:]
        extra = len(top['kids']) - 1
        if extra:
            notes.append('the first line is the root ("%s"); %d more top-level line%s became its children '
                         '(use --root "Title" to make every top-level line a branch)'
                         % (normalize_root(root_text), extra, 's' if extra > 1 else ''))
    root = normalize_root(root_text)
    if root == '':
        raise InputError('--root is empty' if root_option is not None else 'the root line (line %d) is empty' % first['line'])
    if tabbed and spaced:
        notes.append('the outline mixes tabs and spaces: a tab counts as 4 columns, check that the nesting came out as meant')
    shown = [l for l in heading_lines if root_option is not None or l != first['line']]
    if shown:
        notes.append('line %s%s: a Markdown heading (#) stays in the label as text; from-outline nests by indentation only '
                     '(write JSON for a heading-structured document)'
                     % (', '.join(str(l) for l in shown[:5]), ', ...' if len(shown) > 5 else ''))

    def build(item):
        return Node(normalize_label(item['text']), [build(k) for k in item['kids']])
    return Node(root, [build(b) for b in branches]), notes


# --- Light validate ----------------------------------------------------------------------------------
_ITEM = re.compile(r'(\t*)-(?: (.*))?\Z')
_LIST_MARKER = re.compile(r'(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]|\Z)')
# a continuation line: the item's TABs, two spaces, then the text (which may start with an NBSP: only spaces and TABs
# are trimmed)
_CONT = re.compile(r'(\t*)  ([^ \t].*)\Z')
_PLACEHOLDER = re.compile(r'<!--[ \t]*-->[ \t]*\Z')
_FOLD_ANYWHERE = re.compile(r'<!--[ \t]*markmap:[ \t]*fold(?:All)?[ \t]*-->')
_FOLD_ONLY = re.compile(r'<!--[ \t]*markmap:[ \t]*fold(?:All)?[ \t]*-->[ \t]*\Z')


_INVISIBLE = re.compile('[\x00-\x09\x0b-\x1f\x7f\u2028\u2029\ufeff]')


def _visible(s: str) -> str:
    """A line or a label made safe to print (see visible in mindmap.mjs): TAB as \\t, CR as \\r, other invisible
    characters as \\uXXXX; backslashes stay single."""
    def one(m):
        c = m.group(0)
        return '\\t' if c == '\t' else '\\r' if c == '\r' else '\\u%04X' % ord(c)
    return _INVISIBLE.sub(one, s)


def _q(s: str) -> str:
    return '"%s"' % _visible(s)


def _ranges(nums, most=6) -> str:
    """Sorted line numbers as ranges: "4", "4, 7", "19-22, 30" (see lineRanges in mindmap.mjs)."""
    out = []
    i = 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append('%d-%d' % (nums[i], nums[j]) if j > i else '%d' % nums[i])
        i = j + 1
    return ', '.join(out[:most]) + (', ...' if len(out) > most else '')


def _short(s: str, n: int = 48) -> str:
    one = s.replace('\n', ' ⏎ ')
    return one if len(one) <= n else one[:n - 1] + '…'


def _stats(root: Node):
    nodes, depth = 0, 0
    stack = [(root, 0)]
    while stack:
        n, d = stack.pop()
        nodes += 1
        depth = max(depth, d)
        stack.extend((c, d + 1) for c in n.children)
    return nodes, depth


def _tree_warnings(root: Node) -> list:
    out = []
    stack = [(root, 0, None)]
    order = []
    while stack:
        n, d, parent = stack.pop()
        order.append((n, d, parent))
        for c in reversed(n.children):
            stack.append((c, d + 1, n))
    deep = [(n, d) for n, d, _ in order if d > LIMIT_DEPTH]
    for n, d, parent in order:
        where = 'line %d: ' % n.line if n.line else ''
        longest = max(len(l) for l in n.text.split('\n'))
        if longest > LIMIT_LABEL:
            out.append((n.line, '%s%s is %d characters long (over %d): shorten it or split it into children'
                        % (where, _q(_short(n.text)), longest, LIMIT_LABEL)))
        if parent is not None and n.text == '':
            out.append((n.line, '%san empty node under %s: give it a label or remove it'
                        % (where, _q(_short(parent.text) or '(empty)'))))
        if parent is not None and _FOLD_ANYWHERE.search(n.text):
            out.append((n.line, '%s%s holds a fold comment that is not at the end of the label: the map shows it as text, '
                        'Obsidian hides it, and the branch does not open folded; keep " <!-- markmap: fold -->" at the end '
                        'of the last label line' % (where, _q(_short(n.text)))))
        pairs = [l for l in n.text.split('\n') if l.count('%%') >= 2]
        if pairs:
            out.append((n.line, '%s%s has two "%%%%" on one line: Obsidian reads the text between them as a comment and '
                        'hides it; reword the label (for example write "percent")' % (where, _q(_short(pairs[0])))))
        if len(n.children) > LIMIT_CHILDREN:
            out.append((n.line, '%s%s has %d children (over %d): group them under a few sub-branches'
                        % (where, 'the root' if parent is None else _q(_short(n.text)), len(n.children), LIMIT_CHILDREN)))
        seen = {}
        for c in n.children:
            if c.text != '':
                seen.setdefault(re.sub(r'\s+', ' ', c.text.lower()).strip(), []).append(c)
        for same in seen.values():
            if len(same) > 1:
                out.append((same[1].line, 'lines %s: %s appears %d times under %s: merge the duplicates'
                            % (', '.join(str(c.line) for c in same), _q(_short(same[0].text)), len(same),
                               'the root' if parent is None else _q(_short(n.text)))))
    if deep:
        out.append((deep[0][0].line, '%d node%s deeper than %d levels (the deepest at level %d, first at line %d): '
                    'flatten the structure' % (len(deep), '' if len(deep) == 1 else 's', LIMIT_DEPTH,
                                                max(d for _, d in deep), deep[0][0].line)))
    return out


def _read_label(n: Node, written: list, errors: list, unchecked=frozenset()) -> None:
    """The label of an item from its written lines, as the app reads it: placeholder, fold suffix, unescape. The
    lines in unchecked (file line numbers) get no backslash check: a line one TAB too deep is reported on its own."""
    first = n.line
    if written and (_PLACEHOLDER.match(written[0]) or _FOLD_ONLY.match(written[0])):
        n.collapsed = bool(_FOLD_ONLY.match(written[0]))
        written = written[1:]
        first += 1
    if written:
        last = written[-1]
        f = fold_suffix(last)
        if f and f[1] == 0:
            n.collapsed = True
            last = last[:f[0]].rstrip(' \t')
            f2 = fold_suffix(last)
            if f2 and f2[1] != 0:
                last = last[:f2[0]] + last[f2[0] + 1:]
        elif f:
            last = last[:f[0]] + last[f[0] + 1:]
        written = written[:-1] + [last]
    label = []
    for j, l in enumerate(written):
        if l == '':
            continue
        u = unescape_line(l, len(label) == 0, '-')
        fixed = escape_line(u, len(label) == 0, '-')
        if fixed != l and first + j not in unchecked:
            errors.append((first + j, 'line %d: the label line %s needs a backslash: write %s'
                           % (first + j, _q(l), _q(fixed))))
        label.append(u)
    n.text = '\n'.join(label)


_H1 = re.compile(r'#(?:[ \t]|\Z)')
_MAYBE_H1 = re.compile(r' {0,3}(?:#(?:[ \t]|\Z)|=+[ \t]*\Z)')
_ATX_ANY = re.compile(r'#{1,6}(?:[ \t]|\Z)')
# Text before the H1 is skipped up to the first "# " line unless a line could hide that line in a block or make other
# text the root: an indented line, a fence, a %% / $$ / HTML block, a "===" underline (setext H1).
_HIDES_H1 = re.compile(r'[ \t]|`{3}|~{3}|%%|\$\$|<|=+[ \t]*\Z')
# Between the H1 and the list only plain paragraph lines are skipped: an indented line, a block, a quote or another
# list marker could start what this light reader does not follow.
_NOT_PLAIN = re.compile(r'[ \t]|`{3}|~{3}|%%|\$\$|<|>|[-+*](?:[ \t]|\Z)|[0-9]{1,9}[.)](?:[ \t]|\Z)|=+[ \t]*\Z')


def _interrupts(s: str) -> bool:
    """A line that starts a block of its own, so it can never be more of a label (parse.ts interrupts)."""
    return bool(RE_ATX.match(s) or RE_FENCE.match(s) or RE_QUOTE.match(s) or RE_THEMATIC.match(s)
                or RE_HTML1TO6.match(s))


def _first_line_block(s: str) -> bool:
    """Marker-line text that starts a block: the item has no label, only a note (parse.ts firstLineBlock)."""
    return _interrupts(s) or bool(RE_HTML7.match(s)) or link_def_start(s)


def _block_name(s: str) -> str:
    if RE_ATX.match(s):
        return 'a heading'
    if s.startswith('>'):
        return 'a quote'
    if RE_FENCE.match(s):
        return 'a code block'
    if RE_THEMATIC.match(s):
        return 'a horizontal rule'
    if s.startswith('<'):
        return 'an HTML block'
    return 'a link reference definition'


def _plural(n: int, word: str) -> str:
    return '%d %s%s' % (n, word, '' if n == 1 else 's')


def _h1_below_text(lines: list, i: int):
    """The index of the "# " line when the lines from i to it can be skipped as text before the H1, else None."""
    for j in range(i, len(lines)):
        t = lines[j]
        if _H1.match(t):
            return j
        if t.strip(' \t') != '' and _HIDES_H1.match(t):
            return None
    return None


def _list_below_text(lines: list, i: int):
    """From line i, text right below the H1: (j, None) when plain paragraphs and blank lines lead to the top-level
    "- " item at line j (the app reads it as the first item of the map); else (j, why) for the line where reading
    stops: 'heading' (a heading: the list below it is not the map), 'underline' (a "-" or "=" line right under text
    makes that text a heading), 'block' (a line this light reader does not follow) or 'end' (no list)."""
    para = False
    for j in range(i, len(lines)):
        t = lines[j]
        if t.strip(' \t') == '':
            para = False
        elif para and re.match(r'(?:=+|-+)[ \t]*\Z', t):
            return j, 'underline'
        elif RE_THEMATIC.match(t):
            return j, 'block'
        elif re.match(r'-(?: |\Z)', t):
            return j, None
        elif _ATX_ANY.match(t):
            return j, 'heading'
        elif _NOT_PLAIN.match(t):
            return j, 'block'
        else:
            para = True
    return len(lines), 'end'


def validate_light(text: str, basename: str):
    """Checks the canonical form and reports anything else as an error, with its line. It reads on past plain text
    before the H1 or between the H1 and the list (as Markdown and the app do), and a list ends at the first line that
    is not an item or a continuation line. Returns (root, h1, errors, warnings, prefix, stop): each finding is (line,
    message); prefix is the text before the H1 (front matter, blank lines, text), kept out of the map; stop is the
    line where reading stopped although the map may go on (the outline is partial), else None."""
    errors, warnings = [], []
    stop = None
    src = strip_bom(text)
    if src != text:
        warnings.append((0, 'the file starts with a byte order mark (BOM); the canonical form has none'))
    if '\r' in src:
        crlf, lf = [], []
        for n, part in enumerate(src.split('\n')[:-1]):
            (crlf if part.endswith('\r') else lf).append(n + 1)
        if crlf and lf:
            # the majority, the first line break deciding a tie (as the app's reader, format rule R1)
            crlf_major = len(crlf) > len(lf) or (len(crlf) == len(lf) and crlf[0] < lf[0])
            few, many = (lf, 'CRLF') if crlf_major else (crlf, 'LF')
            errors.append((0, 'mixed line endings: %s with %s, the rest of the file with %s; the canonical form uses '
                              'LF throughout' % ('line %s ends' % _ranges(few) if len(few) == 1 else 'lines %s end' % _ranges(few),
                                                 'LF' if many == 'CRLF' else 'CRLF', many)))
        elif crlf:
            errors.append((0, 'CRLF line endings: the canonical form uses LF'))
        src = src.replace('\r\n', '\n')
        for n, part in enumerate(src.split('\n')):
            if '\r' in part:
                errors.append((n + 1, 'line %d holds a carriage return inside the line (%s): the canonical form has none'
                               % (n + 1, _q(part))))
                break
    lines = src.split('\n')
    if lines and lines[-1] == '':
        lines.pop()
    elif lines:
        errors.append((len(lines), 'the file does not end with a newline'))
    i = 0
    if lines and lines[0].rstrip(' \t') == '---':
        for j in range(1, len(lines)):
            if re.match(r'(?:---|\.\.\.)[ \t]*\Z', lines[j]):
                i = j + 1
                break
    fm_end = i
    while i < len(lines) and lines[i].strip(' \t') == '':
        i += 1
    # the H1: here, or below text that Markdown and the app skip the same way (a list above an H1 is such text too;
    # with no line below that could be an H1, a list here is the map of a file without one)
    h = i
    if i < len(lines) and not _H1.match(lines[i]) and (
            not _ITEM.match(lines[i]) or any(_MAYBE_H1.match(l) for l in lines[i + 1:])):
        h = _h1_below_text(lines, i)
    root = Node(basename)
    h1 = False
    if h is None:
        errors.append((i + 1, 'expected the "# Root" line here, found %s' % _q(_short(lines[i]))))
        return root, h1, errors, warnings, '\n'.join(lines[:i]) + '\n' if i else '', i + 1
    prefix = '\n'.join(lines[:h]) + '\n' if h else ''
    where = 'has the H1 right below the closing "---" of the front matter' if fm_end else 'starts with the H1'
    if h < len(lines) and _H1.match(lines[h]):
        text_lines = [n + 1 for n in range(fm_end, h) if lines[n].strip(' \t') != '']
        if text_lines:
            errors.append((text_lines[0], 'line %d: text before the H1 is not on the map (%s, kept in the file); the '
                                          'canonical form %s' % (text_lines[0], _plural(len(text_lines), 'line'), where)))
        elif h > fm_end:
            # as from-json writes it: the H1 is the first line, or the line right below the front matter
            errors.append((fm_end + 1, 'line %d: %s before the H1: the canonical form %s'
                           % (fm_end + 1, 'a blank line' if h - fm_end == 1 else 'blank lines', where)))
        i = h
        t = trim_closing_hashes(lines[i][1:].lstrip(' \t')).rstrip(' \t')
        root = Node(unescape_root(t), line=i + 1)
        h1 = True
        i += 1
        j = i
        while j < len(lines) and lines[j].strip(' \t') == '':
            j += 1
        if j < len(lines) and re.match(r'---[ \t]*\Z', lines[j]):
            for c in range(j + 1, len(lines)):
                if re.match(r'(?:---|\.\.\.)[ \t]*\Z', lines[c]):
                    # Obsidian properties written below the H1 (the same message as mindmap.mjs validate)
                    heading = lines[c].rstrip(' \t') == '---' and lines[c - 1].strip(' \t') != ''
                    errors.append((j + 1, 'line %d: front matter must be the first lines of the file, above the H1: move '
                                          'lines %d-%d above line %d (below the H1, %s)'
                                   % (j + 1, j + 1, c + 1, root.line,
                                      'Markdown reads "---" as a rule and the YAML as a heading, so the map is empty'
                                      if heading else 'Obsidian does not read it as properties and shows the YAML as text')))
                    return root, h1, errors, warnings, prefix, None
        blanks = 0
        while i < len(lines) and lines[i].strip(' \t') == '':
            blanks += 1
            i += 1
        if i < len(lines) and not _ITEM.match(lines[i]):
            j, why = _list_below_text(lines, i)
            if why is None:
                n_text = sum(1 for n in range(i, j) if lines[n].strip(' \t') != '')
                errors.append((i + 1, 'line %d: text between the H1 and the list is not on the map (%s, kept in the file); '
                                      'the canonical form has the list one blank line below the H1'
                               % (i + 1, _plural(n_text, 'line'))))
                i = j
            else:
                hint = {
                    'heading': 'the heading at line %d comes before the list, and a list after a heading is not the map'
                               % (j + 1),
                    'underline': 'a line of only "-" or "=" right under text makes that text a heading, and a list after '
                                 'a heading is not the map',
                    'block': 'text between the H1 and the list is not on the map, and this light validate does not read '
                             'past line %d' % (j + 1),
                    'end': 'text between the H1 and the list is not on the map, and no list follows it',
                }[why]
                errors.append((i + 1, 'line %d is not in the canonical form: %s (%s; for other files run: node mindmap.mjs '
                                      'validate)' % (i + 1, _q(_short(lines[i])), hint)))
                return root, h1, errors, warnings, prefix, j + 1 if why == 'block' else None
        elif i < len(lines) and blanks != 1:
            errors.append((i, 'write exactly one blank line between the H1 and the list (found %d)' % blanks))
    elif h < len(lines):
        i = h
        warnings.append((0, 'no H1: the root is the file name %s; start the file with %s' % (_q(basename), _q('# ' + basename))))
    else:
        errors.append((h + 1, 'expected the "# Root" line here, found the end of the file'))
        return root, h1, errors, warnings, prefix, None
    if i >= len(lines):
        errors.append((0, 'no map: the file has no list: write the map as a "- " list under the H1'))
        return root, h1, errors, warnings, prefix, None
    stack = [root]
    current = None
    current_tabs = 0
    written = {}
    deep = set()
    blank = []
    k = i
    while k < len(lines):
        line = lines[k]
        if line.strip(' \t') == '':
            blank.append(k + 1)
            k += 1
            continue
        m = _ITEM.match(line)
        c = _CONT.match(line)
        if m:
            tabs = len(m.group(1))
            if tabs > len(stack) - 1:
                extra = tabs - (len(stack) - 1)
                too_deep = ('line %d has %d TAB%s, but the item above allows at most %d (one TAB per level): remove %s to '
                            'make it a child' % (k + 1, tabs, '' if tabs == 1 else 's', len(stack) - 1,
                                                 'one TAB' if extra == 1 else '%d TABs' % extra))
                own = written[id(current)] if current is not None else []
                if own and not blank and not _PLACEHOLDER.match(own[0]) and not _FOLD_ONLY.match(own[0]):
                    # as Markdown and the app read it: indented past any child of the item above, the line continues
                    # that item's text, so the outline shows it in that label ("Tools ⏎ - Slack"), not as a child
                    errors.append((k + 1, too_deep + ' (with a TAB too many, Markdown reads the line as more of the label '
                                                      'above)'))
                    own.append(line.lstrip('\t').rstrip(' \t'))
                    deep.add(k + 1)
                    k += 1
                    continue
                # after a blank line or below an item without text, Markdown and the app read it as a note (indented
                # code), not as a node: the map may go on below it, so reading stops here
                errors.append((k + 1, too_deep + ' (with a TAB too many %s, Markdown reads the line as a note the map does '
                                                 'not show; this light validate does not read past this line, so the '
                                                 'outline above stops here)'
                               % ('after a blank line' if blank else 'here')))
                stop = k + 1
                break
            if blank:
                errors.append((blank[0], 'blank line%s inside the list (line %s): remove %s'
                               % ('s' if len(blank) > 1 else '', ', '.join(str(b) for b in blank[:6]),
                                  'them' if len(blank) > 1 else 'it')))
                blank = []
            content = m.group(2) if m.group(2) is not None else ''
            text = content.rstrip(' \t')
            if text and not _PLACEHOLDER.match(text) and not _FOLD_ONLY.match(text) and _first_line_block(text):
                # Markdown and the app read the item as an empty node with a note (the map may go on below it)
                errors.append((k + 1, 'line %d: %s right after the marker starts %s, so Markdown and the app read the item '
                                      'as an empty node with a note, not as its label (to make it the label it needs a '
                                      'backslash: write %s); this light validate does not read past this line, so the '
                                      'outline above stops here'
                               % (k + 1, _q(_short(text)), _block_name(text), _q(_short(escape_line(text, True, '-'))))))
                stop = k + 1
                break
            del stack[tabs + 1:]
            current = Node('', line=k + 1)
            current_tabs = tabs
            written[id(current)] = [content] if content.strip(' \t') != '' else []
            stack[-1].children.append(current)
            stack.append(current)
        elif (c and current is not None and len(c.group(1)) == current_tabs and not blank
              and not _LIST_MARKER.match(c.group(2))):
            if _interrupts(c.group(2)):
                # below a label, a line that starts a block ends it: that line and the ones after it are a note
                errors.append((k + 1, 'line %d: %s starts %s, so Markdown and the app read it as a note under %s, not as '
                                      'more of its label (to make it part of the label it needs a backslash: write %s); '
                                      'this light validate does not read past this line, so the outline above stops here'
                               % (k + 1, _q(_short(c.group(2))), _block_name(c.group(2)),
                                  _q(_short(written[id(current)][0] if written[id(current)] else '(empty)')),
                                  _q(_short(escape_line(c.group(2), False, '-'))))))
                stop = k + 1
                break
            if not written[id(current)]:
                errors.append((k + 1, 'line %d: write the label on the marker line, not below it' % (k + 1)))
            written[id(current)].append(c.group(2))
        else:
            break
        k += 1
    if k < len(lines) and stop is None:
        rest = lines[k]
        col, _, after = lead(rest)
        comment = re.match(r'<!--|%%|\$\$', after)
        # the list ends here for Markdown and the app too: a line at the margin, after a blank line or one that
        # starts a block of its own (a heading, a quote, a fence, a rule); else the map may go on below this line
        ends = (col == 0 and not _LIST_MARKER.match(after) and not comment
                and bool(blank or _ATX_ANY.match(after) or after.startswith('>') or RE_FENCE.match(after)
                         or RE_THEMATIC.match(after)))
        if _LIST_MARKER.match(after):
            hint = 'indent with one TAB per level and use "- " markers'
        elif col > 0:
            hint = ('a line break inside a label is the item\'s TABs plus two spaces, right below the item; '
                    'anything else under an item is a note the map does not show')
        elif comment:
            hint = 'a comment line is not on the map'
        elif not ends:
            hint = ('right below an item, Markdown reads it as more of that label: indent it as the item\'s TABs plus two '
                    'spaces, or put a blank line before it if it is not part of the label')
        else:
            hint = 'content after the list is not on the map'
        if not ends:
            stop = k + 1
            hint += '; this light validate does not read past this line, so the outline above stops here'
        errors.append((k + 1, 'line %d is not in the canonical form: %s (%s; for other files run: node mindmap.mjs validate)'
                       % (k + 1, _q(_short(rest)), hint)))
    elif blank and stop is None:
        errors.append((blank[0], 'blank line%s after the list (line %s): the file ends with the last item'
                       % ('s' if len(blank) > 1 else '', ', '.join(str(b) for b in blank[:6]))))
    for n in _walk(root):
        if n is not root:
            _read_label(n, written[id(n)], errors, deep)
            n.collapsed = n.collapsed and bool(n.children)
    warnings.extend(_tree_warnings(root))
    return root, h1, errors, warnings, prefix, stop


def _walk(root: Node):
    stack = [root]
    while stack:
        n = stack.pop()
        yield n
        stack.extend(reversed(n.children))


# --- Command line ---------------------------------------------------------------------------------------
USAGE = """mindmap.py %s: write and check Mindslate mind maps (the Python fallback of mindmap.mjs)

Usage:
  python3 mindmap.py from-json <file.json|-> [-o out.md] [--front-matter <yaml>]... [--force]
  python3 mindmap.py from-outline <file.txt|-> [--root "Title"] [-o out.md] [--front-matter <yaml>]... [--force]
  python3 mindmap.py validate <file.md|->

from-json and from-outline write the same bytes as `node mindmap.mjs`. validate is lighter: it checks the
canonical form ('# Root', one blank line, a TAB-indented '- ' list) and the round trip, reports anything else as an
error, and says where it stops reading a file it does not follow.

Options:
  -o, --output <file>  write the map to this file instead of standard output
  --force              replace the output file if it exists (without it an existing file is never touched)
  --front-matter <yaml>  from-json, from-outline: Obsidian properties above the H1, between "---" lines the CLI
                       writes; once per YAML line, e.g. --front-matter 'tags: [launch, q3]' --front-matter 'date: 2026-07-15'
  --root <text>        from-outline: the root text; every top-level line becomes a branch
  -h, --help           show this help

Exit codes: 0 ok (warnings allowed), 1 errors, 2 usage.
""" % VERSION


class UsageError(Exception):
    pass


def _parse_args(argv):
    if not argv:
        raise UsageError('')
    command, rest = argv[0], argv[1:]
    opts = {'files': [], 'output': None, 'root': None, 'front_matter': [], 'force': False, 'help': False}
    used = set()
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == '--':
            opts['files'].extend(rest[i + 1:])
            break
        if a in ('-o', '--output', '--root'):
            if i + 1 >= len(rest):
                raise UsageError('%s needs a value' % a)
            name = 'root' if a == '--root' else 'output'
            opts[name] = rest[i + 1]
            used.add(name)
            i += 2
            continue
        if a == '--front-matter':
            if i + 1 >= len(rest):
                raise UsageError('%s needs a value' % a)
            opts['front_matter'].append(rest[i + 1])
            used.add('front-matter')
            i += 2
            continue
        if a.startswith('--front-matter='):
            opts['front_matter'].append(a.split('=', 1)[1])
            used.add('front-matter')
        elif a.startswith('--output=') or a.startswith('--root='):
            name = 'root' if a.startswith('--root=') else 'output'
            opts[name] = a.split('=', 1)[1]
            used.add(name)
        elif a == '--force':
            opts['force'] = True
            used.add('force')
        elif a in ('-h', '--help'):
            opts['help'] = True
        elif a.startswith('-') and a != '-':
            raise UsageError('unknown option %s' % a)
        else:
            opts['files'].append(a)
        i += 1
    if opts['output'] == '':
        raise UsageError('-o needs a file name')
    allowed = {'from-json': {'output', 'force', 'front-matter'}, 'from-outline': {'output', 'force', 'root', 'front-matter'},
               'validate': set()}
    if command in allowed:
        for u in sorted(used):
            if u not in allowed[command]:
                raise UsageError('%s does not take --%s' % (command, u))
    return command, opts


def _read(path: str) -> str:
    try:
        if path == '-':
            data = sys.stdin.buffer.read()
        else:
            with open(path, 'rb') as f:
                data = f.read()
    except OSError as e:
        raise InputError('cannot read %s: %s' % ('standard input' if path == '-' else _q(path), e.strerror or e))
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        raise InputError('%s is not UTF-8 text' % ('standard input' if path == '-' else _q(path)))


def _write(path: str, text: str, force: bool) -> None:
    try:
        with open(path, 'w' if force else 'x', encoding='utf-8', newline='\n') as f:
            f.write(text)
    except FileExistsError:
        raise InputError('cannot write %s: the file exists (pass --force to replace it)' % _q(path))
    except OSError as e:
        raise InputError('cannot write %s: %s' % (_q(path), e.strerror or e))


def _err(text: str) -> None:
    sys.stderr.write(text)
    sys.stderr.flush()


def _out(text: str) -> None:
    sys.stdout.buffer.write(text.encode('utf-8'))
    sys.stdout.flush()


def _base_name(path: str) -> str:
    last = re.split(r'[\\/]', path)[-1]
    stem = re.sub(r'\.(?:md|markdown)\Z', '', last, flags=re.I)
    return stem or 'Untitled'


def _outline(root: Node) -> list:
    out = []
    stack = [(root, 0)]
    while stack:
        n, d = stack.pop()
        label = '(empty)' if n.text == '' else _visible(n.text.replace('\n', ' ⏎ '))
        out.append('  ' * d + label + ('  (collapsed)' if n.collapsed else ''))
        stack.extend((c, d + 1) for c in reversed(n.children))
    return out


def _summary_line(root: Node, warnings, where: str) -> str:
    nodes, depth = _stats(root)
    b = len(root.children)
    return '%s%d node%s (%d below the root), depth %d, %d main branch%s%s' % (
        where, nodes, '' if nodes == 1 else 's', nodes - 1, depth, b, '' if b == 1 else 'es',
        ', %d warning%s' % (len(warnings), '' if len(warnings) == 1 else 's') if warnings else '')


def _name_warnings(path: str) -> list:
    """Warnings about the name of the -o file (see fileNameWarnings in mindmap.mjs): never a refusal."""
    base = re.split(r'[\\/]', path)[-1]
    shown = _q(base)
    out = []
    bad = []
    for c in base:
        if c in ':*?"<>|#^[]' and c not in bad:
            bad.append(c)
    if bad:
        out.append('the file name %s has %s in it: leave out / \\ : * ? " < > | # ^ [ ] (Obsidian refuses some of them in '
                   'note names, and links to the note break on the others)' % (shown, ' and '.join(bad)))
    if base.startswith('.'):
        out.append('the file name %s starts with a dot: Finder and Obsidian hide such files; leave the dot out' % shown)
    if not re.search(r'\.md\Z', base, re.I | re.A):
        out.append('the file name %s does not end in ".md": Obsidian shows only .md files as notes' % shown)
    return out


def _emit_map(root: Node, notes, opts, root_only_hint='') -> int:
    for n in notes:
        _err('mindmap.py: note: %s\n' % n)
    if not root.children:
        # validate reports such a file as an error ("no map"), so the writer refuses it too
        _err('mindmap.py: error: the map is only its root: give it branches (children)%s; nothing was written\n' % root_only_hint)
        return 1
    # Obsidian properties above the H1 (checked before anything is written; an InputError exits 1)
    text = (front_matter_block(opts['front_matter']) if opts['front_matter'] else '') + write_map(root)
    if opts['output'] is not None:
        _write(opts['output'], text, opts['force'])
    else:
        _out(text)
    _, _, _, warnings, _, _ = validate_light(text, 'Untitled')
    warnings.sort(key=lambda w: w[0] or 0)
    names = _name_warnings(opts['output']) if opts['output'] is not None else []
    _err('mindmap.py: %s\n' % _summary_line(root, warnings + [(0, n) for n in names],
                                              'wrote %s: ' % opts['output'] if opts['output'] is not None else ''))
    for _, w in warnings[:20]:
        _err('mindmap.py: warning: %s\n' % w)
    for n in names:
        _err('mindmap.py: warning: %s\n' % n)
    return 0


def check_file(text: str, basename: str):
    """validate: (root, errors, warnings, round_trip_ok, stop). The round trip re-writes the map with write_map; stop
    is the line where reading stopped although the map may go on, else None."""
    root, h1, errors, warnings, prefix, stop = validate_light(text, basename)
    if any(not m.startswith('no map:') for _, m in errors):
        return root, errors, warnings, False, stop
    # no errors, or only "no map" (an H1 and nothing else): the map is still read, so the round trip is checked,
    # as mindmap.mjs does
    canonical = write_map(root)
    if not h1:
        canonical = canonical.split('\n', 2)[2] if root.children else ''
    canonical = prefix + canonical
    src = strip_bom(text)
    if canonical == src:
        return root, errors, warnings, True, stop
    a, b = canonical.split('\n'), src.split('\n')
    at = 0
    while at < max(len(a), len(b)) and (a[at] if at < len(a) else None) == (b[at] if at < len(b) else None):
        at += 1
    errors.append((at + 1, 'round trip failed at line %d: re-writing the map gives %s, the file has %s' % (
        at + 1, _q(a[at]) if at < len(a) else '(end of file)', _q(b[at]) if at < len(b) else '(end of file)')))
    return root, errors, warnings, False, stop


def main(argv) -> int:
    try:
        command, opts = _parse_args(argv)
    except UsageError as e:
        _err(('mindmap.py: %s\n\n' % e if str(e) else '') + USAGE)
        return 2
    if command in ('-h', '--help', 'help') or opts['help']:
        _out(USAGE)
        return 0
    if command in ('--version', 'version'):
        _out(VERSION + '\n')
        return 0
    if command not in ('from-json', 'from-outline', 'validate'):
        hint = ' (to-json needs Node: node mindmap.mjs to-json)' if command == 'to-json' else ''
        _err('mindmap.py: unknown command %s%s\n\n%s' % (_q(command), hint, USAGE))
        return 2
    if len(opts['files']) != 1:
        _err('mindmap.py: %s takes one input file (- reads standard input), got %d\n\n%s'
             % (command, len(opts['files']), USAGE))
        return 2
    path = opts['files'][0]
    try:
        source = _read(path)
        if command == 'from-json':
            return _emit_map(tree_from_json(source), [], opts)
        if command == 'from-outline':
            root, notes = tree_from_outline(source, opts['root'])
            return _emit_map(root, notes, opts, ' (from-outline makes one node per line, nested by indentation: '
                             'a paragraph of notes is not an outline; plan the tree and write JSON)')
        root, errors, warnings, round_trip, stop = check_file(source, 'Untitled' if path == '-' else _base_name(path))
    except InputError as e:
        _err('mindmap.py: %s\n' % e)
        return 1
    # stopped before the list: no tree was read (and before the H1, not even the root)
    unread = stop is not None and not root.children
    shown_root = (root.text or '(empty)') if root.line or not unread else '(not read)'
    full = [shown_root] if unread else _outline(root)
    out = full[:OUTLINE_LINES]
    if len(full) > OUTLINE_LINES:
        # as mindmap.mjs: never a silent cut (the nodes line below counts them all)
        out.append('... %d more nodes (not shown; the nodes line below counts them all)' % (len(full) - OUTLINE_LINES))
    out.append('')
    out.append('file:        %s' % ('(stdin)' if path == '-' else path))
    out.append('root:        %s' % shown_root)
    nodes, depth = _stats(root)
    b = len(root.children)
    if unread:
        out.append('nodes:       not read: this light validate stops at line %d (see the errors)' % stop)
    else:
        out.append('nodes:       %d (%d below the root), depth %d, %d main branch%s%s' % (
            nodes, nodes - 1, depth, b, '' if b == 1 else 'es',
            '; the outline stops before line %d, which this light validate does not read (see the errors)' % stop
            if stop else ''))
    out.append('round trip:  %s' % ('ok (re-writing the parsed map gives the same bytes)' if round_trip
                                    else 'not ok (see the errors)'))
    out.append('warnings:    %s' % (len(warnings) if warnings else 'none'))
    out.extend('  ' + w for _, w in sorted(warnings, key=lambda w: w[0] or 0))
    if errors:
        out.append('errors:      %d' % len(errors))
        out.extend('  ' + (m if m.startswith('line ') or not l else 'line %d: %s' % (l, m))
                   for l, m in sorted(errors, key=lambda e: e[0] or 0))
    n = len(warnings)
    out.append('result:      %s' % ('FAILED' if errors else ('OK with %d warning%s' % (n, '' if n == 1 else 's') if n else 'OK')))
    _out('\n'.join(out) + '\n')
    return 1 if errors else 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (RecursionError, MemoryError) as exc:
        _err('mindmap.py: the input is too large or too deeply nested (%s)\n' % type(exc).__name__)
        sys.exit(1)
