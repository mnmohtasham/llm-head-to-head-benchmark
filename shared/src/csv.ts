/**
 * One CSV cell. Text a spreadsheet would read as a formula, starting with = + - @, a tab or a
 * carriage return, gets a leading apostrophe, so a model id, machine name or error message from a
 * machine can never run as a formula in Excel or LibreOffice. Numbers stay numbers.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
