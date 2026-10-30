/** File-name helpers shared by both shells. Pure string functions, no I/O. */
import { escapeRoot } from './escape.js';

/** The H1 line for a root text: '# text', or a bare '#' for an empty root (R3). */
export function headingLine(rootText: string): string {
  const esc = escapeRoot(rootText);
  return esc ? '# ' + esc : '#';
}

/**
 * Root text for a file without an H1 (R3): the file name without directories and without a
 * `.md` / `.markdown` extension; 'Untitled' when nothing is left.
 */
export function baseName(fileName: string): string {
  const last = fileName.split(/[\\/]/).pop() ?? '';
  const stem = last.replace(/\.(?:md|markdown)$/i, '');
  return stem === '' ? 'Untitled' : stem;
}

/** Content of a brand-new file (R1/R14): the H1 and one LF, no BOM. The first edit adds the list. */
export function newFileText(basename: string): string {
  return headingLine(basename) + '\n';
}
