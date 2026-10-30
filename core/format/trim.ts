/**
 * Trimming helpers for the reader and the writer, each one pass over the string (LINEAR, escape.ts). They replace
 * expressions such as `/[ \t]+$/`, which the regular expression engine tries from every position of a long run of
 * spaces (or line breaks) that is not at the end: quadratic time on a crafted line, and the web page reads files
 * that are not the user's own (a share link). Each returns exactly what the expression named in its comment gives
 * (fuzz.test.ts FZ5).
 */

const isBlank = (c: number): boolean => c === 0x20 || c === 0x09;

/** `s.replace(/[ \t]+$/, '')`: without its trailing spaces and tabs. */
export function trimEndBlank(s: string): string {
  let e = s.length;
  while (e > 0 && isBlank(s.charCodeAt(e - 1))) e--;
  return e === s.length ? s : s.slice(0, e);
}

/** `s.replace(/^[ \t]+|[ \t]+$/g, '')`: without its leading and trailing spaces and tabs. */
export function trimBlank(s: string): string {
  let b = 0;
  while (b < s.length && isBlank(s.charCodeAt(b))) b++;
  let e = s.length;
  while (e > b && isBlank(s.charCodeAt(e - 1))) e--;
  return b === 0 && e === s.length ? s : s.slice(b, e);
}

/** `s.replace(/(?:\r?\n)+$/, '')`: without its trailing line breaks. */
export function trimEndLineBreaks(s: string): string {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 0x0a) {
    e--;
    if (e > 0 && s.charCodeAt(e - 1) === 0x0d) e--;
  }
  return e === s.length ? s : s.slice(0, e);
}

/** `s.replace(/(?:\r?\n[ \t]*)+$/, '')`: without its trailing line breaks and the spaces and tabs after each. */
export function trimEndBlankLines(s: string): string {
  let cut = s.length;
  for (let i = s.length; ; ) {
    let j = i;
    while (j > 0 && isBlank(s.charCodeAt(j - 1))) j--;
    if (j === 0 || s.charCodeAt(j - 1) !== 0x0a) break;
    j--;
    if (j > 0 && s.charCodeAt(j - 1) === 0x0d) j--;
    cut = j;
    i = j;
  }
  return cut === s.length ? s : s.slice(0, cut);
}

/**
 * `s.replace(/(?:^|[ \t]+)#+[ \t]*$/, '')`: an ATX heading's text without its closing sequence (a run of "#" at
 * the end, after spaces or tabs or alone, and the blanks around it).
 */
export function trimClosingHashes(s: string): string {
  let t = s.length;
  while (t > 0 && isBlank(s.charCodeAt(t - 1))) t--;
  let h = t;
  while (h > 0 && s.charCodeAt(h - 1) === 0x23) h--;
  if (h === t) return s; // no "#" run at the end
  if (h === 0) return '';
  if (!isBlank(s.charCodeAt(h - 1))) return s; // "a#": part of the text
  let b = h;
  while (b > 0 && isBlank(s.charCodeAt(b - 1))) b--;
  return s.slice(0, b);
}
