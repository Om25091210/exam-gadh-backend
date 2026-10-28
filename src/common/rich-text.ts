/**
 * Question and note text is stored as plain text with a tiny allow-list of inline markers:
 * [b] [i] [sub] [sup]. There is no HTML anywhere: raw tags are stripped on write and the clients
 * render the markers as React elements, never with dangerouslySetInnerHTML.
 */
const MARKERS = ['b', 'i', 'sub', 'sup'] as const;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HTML_TAG = /<\/?[a-zA-Z!][^>]*>/g;

export function sanitizeRichText(input: string): string {
  let s = input.normalize('NFC').replace(CONTROL, '').replace(HTML_TAG, '');
  s = s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return balanceMarkers(s);
}

/** Drops any marker that is not properly opened and closed, so renderers never see unbalanced input. */
function balanceMarkers(s: string): string {
  for (const m of MARKERS) {
    const open = `[${m}]`;
    const close = `[/${m}]`;
    let depth = 0;
    let out = '';
    for (let i = 0; i < s.length; ) {
      if (s.startsWith(open, i)) {
        depth++;
        out += open;
        i += open.length;
      } else if (s.startsWith(close, i)) {
        if (depth > 0) {
          depth--;
          out += close;
        }
        i += close.length;
      } else {
        out += s[i++];
      }
    }
    while (depth-- > 0) out += close;
    s = out;
  }
  return s;
}

/** Plain text without markers (used for hashing, search and exports). */
export function stripMarkers(s: string): string {
  return s.replace(/\[\/?(b|i|sub|sup)\]/g, '');
}

/** Neutralise spreadsheet formula injection in CSV/XLSX exports. */
export function csvSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
