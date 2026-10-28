import { csvSafe, sanitizeRichText, stripMarkers } from './rich-text';

describe('sanitizeRichText', () => {
  it('strips HTML tags and scripts completely', () => {
    expect(sanitizeRichText('Hello <script>alert(1)</script><b onclick="x">world</b>')).toBe('Hello alert(1)world');
    expect(sanitizeRichText('<img src=x onerror=alert(1)>text')).toBe('text');
  });

  it('keeps the four allowed markers and balances them', () => {
    expect(sanitizeRichText('H[sub]2[/sub]O is [b]water[/b]')).toBe('H[sub]2[/sub]O is [b]water[/b]');
    expect(sanitizeRichText('[b]open only')).toBe('[b]open only[/b]');
    expect(sanitizeRichText('close only[/b]')).toBe('close only');
    expect(sanitizeRichText('[i]x[/i][/i]')).toBe('[i]x[/i]');
  });

  it('normalises whitespace, control characters and newlines; keeps Devanagari intact', () => {
    expect(sanitizeRichText('  a\u0000  b \r\n\r\n\r\n\r\n c  ')).toBe('a b\n\nc');
    expect(sanitizeRichText('छत्तीसगढ़ का इतिहास')).toBe('छत्तीसगढ़ का इतिहास');
  });

  it('normalises to NFC so visually equal strings compare equal', () => {
    expect(sanitizeRichText('e\u0301')).toBe('\u00e9');
  });

  it('stripMarkers removes markers only', () => {
    expect(stripMarkers('x[sup]2[/sup] [b]y[/b]')).toBe('x2 y');
  });

  it('csvSafe neutralises spreadsheet formulas', () => {
    expect(csvSafe('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvSafe('+1')).toBe("'+1");
    expect(csvSafe('@cmd')).toBe("'@cmd");
    expect(csvSafe('plain')).toBe('plain');
  });
});
