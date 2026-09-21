import type { TreeEntry } from '../../types';

const README_NAMES = new Set(['README.md', 'README.markdown', 'README.mdown', 'README.txt', 'README']);
// Upper bound for in-browser editing; larger files stay git-only.
const MAX_EDIT_CHARS = 262_144;

function isReadmePath(path: string): boolean {
  return README_NAMES.has(path);
}

function findReadmeEntry(entries: TreeEntry[], path: string): TreeEntry | undefined {
  return path === '' ? entries.find((e) => e.type === 'blob' && README_NAMES.has(e.path)) : undefined;
}

function isEditableSize(textLength: number, maxChars: number = MAX_EDIT_CHARS): boolean {
  return textLength <= maxChars;
}

export { README_NAMES, MAX_EDIT_CHARS, isReadmePath, findReadmeEntry, isEditableSize };
