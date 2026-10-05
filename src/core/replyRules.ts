/** Deterministic checks on each coach reply. Used by the eval and logged in chat. */

export const MAX_WORDS = 80;
export const MAX_QUESTIONS = 1;

/** The fixed last line of the coach's wrap-up message. prompts/coach.md quotes it word for word. */
export const WRAP_UP_LINE = "If anything's off or too much, say what to change. Otherwise type /done.";

export interface ReplyCheck {
  words: number;
  questions: number;
  ok: boolean;
  problems: string[];
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Counts question marks, ignoring quoted examples ("e.g. 'Who signs off?'")
 * and an either/or tail ("Is it A? Or B?"), which both read as one question.
 * The eval's judge also checks "one ask per message" in meaning, so this
 * only needs to catch the obvious cases.
 */
export function questionCount(text: string): number {
  // A tentative KR in a recap line, "(KR 2.1?)", is a label, not a question.
  const unquoted = text.replace(/[“"][^”"\n]*[”"]/g, "").replace(/\(KRs? [^()\n]*\?\)/gi, "");
  const all = (unquoted.match(/\?/g) ?? []).length;
  const orTails = (unquoted.match(/\?\s+or\b/gi) ?? []).length;
  return all - orTails;
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

/** True when the message is the coach's wrap-up: it tells the person to type /done. */
export function isWrapUp(text: string): boolean {
  return /type\s+\/done/i.test(text);
}

/** Number of recap lines (one per outcome, each starting with "- ") before the /done line. */
export function recapOutcomeCount(text: string): number {
  const lines = text.split("\n");
  const end = lines.findIndex((l) => /\/done/i.test(l));
  return lines.slice(0, end === -1 ? lines.length : end).filter((l) => /^\s*[-•*]\s+\S/.test(l)).length;
}
