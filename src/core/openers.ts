import type { OkrRow, Person } from "../domain/schemas.js";
import { shortDate } from "./time.js";

export type Touchpoint = "plan" | "checkin" | "review";

/** Tells people they can plan in a few lines instead of a long chat. */
const QUICK_PATH = "Three quick bullets are plenty, or we can talk it through.";

/**
 * Fixed opening messages. They are templates, not model output, so they appear
 * instantly and can never misstate what is open.
 */
export function opener(touchpoint: Touchpoint, person: Person, openItems: OkrRow[]): string {
  const line = (t: OkrRow) => `- ${t.name} (KR ${t.krCode}${t.due ? `, due ${shortDate(t.due)}` : ""})`;

  switch (touchpoint) {
    case "plan":
      if (openItems.length === 0) {
        return `Hi ${person.name}, new week. ${QUICK_PATH} If it's Friday and the week went well, what's true?`;
      }
      if (openItems.length === 1) {
        return [
          `Hi ${person.name}, new week. ${QUICK_PATH}`,
          `This is still in progress on the tracker:`,
          line(openItems[0]!),
          `Do you plan to finish this off this week?`,
        ].join("\n");
      }
      return [
        `Hi ${person.name}, new week. ${QUICK_PATH}`,
        `These are still in progress on the tracker:`,
        ...openItems.map(line),
        `Which of these do you plan to finish off this week?`,
      ].join("\n");
    case "checkin":
      return `Hi ${person.name}, quick mid-week check-in. How are things going with this week's plan?`;
    case "review":
      return `Hi ${person.name}, end of the week. How did it land?`;
  }
}
