import type { ZodError } from 'zod';

/** A number typed in a field. A blank field is NaN, not 0, so it fails like any other typo. */
export function fieldNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

/**
 * The first thing wrong with a form, in words. A field without a number is named by its label
 * (keyed by its path, such as `sampling.seed`): zod itself only says a number was expected.
 */
export function formProblem(error: ZodError, labels: Readonly<Record<string, string>>): string {
  const issue = error.issues[0];
  if (!issue) return 'Check the settings.';
  if (issue.code === 'invalid_type' && issue.expected === 'number') {
    const label = labels[issue.path.join('.')];
    return label ? `${label} needs a number.` : 'A number field is empty or not a number.';
  }
  return issue.message;
}
