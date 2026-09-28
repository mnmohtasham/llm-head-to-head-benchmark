import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/csv';

describe('csvCell', () => {
  it('keeps text a spreadsheet would run as a formula as plain text', () => {
    for (const text of [
      '=HYPERLINK("https://evil.example","x")',
      '+1+1',
      '-2+3',
      '@SUM(A1)',
      '\tx',
      '\rx',
    ]) {
      expect(csvCell(text).replace(/^"/, '').startsWith("'"), JSON.stringify(text)).toBe(true);
    }
  });

  it('leaves numbers, negative ones too, and ordinary text as they are', () => {
    expect(csvCell(-1.5)).toBe('-1.5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell('NVIDIA GeForce RTX 3060')).toBe('NVIDIA GeForce RTX 3060');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes commas, quotes and every kind of line break', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('a\rb')).toBe('"a\rb"');
  });
});
