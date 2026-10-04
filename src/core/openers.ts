import type { OkrRow, Person } from "../domain/schemas.js";
import { shortDate } from "./time.js";

export type Touchpoint = "plan" | "checkin" | "review";

/**
 * Fixed opening messages. They are templates, not model output, so they appear
 * instantly and can never misstate what is open.
 */
export function opener(touchpoint: Touchpoint, person: Person, openItems: OkrRow[]): string {
  const list = openItems
    .map((t) => `- ${t.name} (KR ${t.krCode}${t.due ? `, due ${shortDate(t.due)}` : ""})`)
    .join("\n");

  switch (touchpoint) {
    case "plan":
      if (openItems.length === 0) {
        return `Hi ${person.name}, new week. Let's sketch it out together. What's on your plate this week?`;
      }
      return [
        `Hi ${person.name}, new week. Let's sketch it out together.`,
        `These are still open on the tracker:`,
        list,
        `Do you plan to finish these off this week, or is something else more pressing?`,
      ].join("\n");
    case "checkin":
      return `Hi ${person.name}, quick mid-week check-in. How are things going with this week's plan?`;
    case "review":
      return `Hi ${person.name}, end of the week. How did it land?`;
  }
}
