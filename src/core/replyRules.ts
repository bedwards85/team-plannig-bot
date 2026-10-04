/** Deterministic checks on each coach reply. Used by the eval and logged in chat. */

export const MAX_WORDS = 80;
export const MAX_QUESTIONS = 1;

export interface ReplyCheck {
  words: number;
  questions: number;
  ok: boolean;
  problems: string[];
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function questionCount(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

export function checkReply(text: string): ReplyCheck {
  const words = wordCount(text);
  const questions = questionCount(text);
  const problems: string[] = [];
  if (words === 0) problems.push("empty reply");
  if (words > MAX_WORDS) problems.push(`${words} words (max ${MAX_WORDS})`);
  if (questions > MAX_QUESTIONS) problems.push(`${questions} questions (max ${MAX_QUESTIONS})`);
  return { words, questions, ok: problems.length === 0, problems };
}
