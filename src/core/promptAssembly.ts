import type Anthropic from "@anthropic-ai/sdk";
import type { OkrRow, Person, TeamConfig } from "../domain/schemas.js";
import type { Touchpoint } from "./openers.js";
import { localStamp, shortDate } from "./time.js";

/**
 * Cache layout (all breakpoints use a 1-hour TTL):
 *   system[0]   coach prompt               shared by everyone, all week
 *   system[1]   OKR snapshot               shared by the team, frozen per conversation
 *   messages[0] this person's context      fixed for the life of the conversation
 *   ...tail     covered by the request's automatic top-level cache marker
 * Nothing time-varying goes above the last breakpoint: the current time is a
 * separate text block on each new user turn.
 */
const ONE_HOUR = { type: "ephemeral", ttl: "1h" } as const;

export function buildSystem(coachPrompt: string, okrSnapshot: string): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: coachPrompt, cache_control: ONE_HOUR },
    { type: "text", text: okrSnapshot, cache_control: ONE_HOUR },
  ];
}

export interface ContextInput {
  team: TeamConfig;
  person: Person;
  touchpoint: Touchpoint;
  weekOf: string; // YYYY-MM-DD, Monday of the week
  openItems: OkrRow[];
}

const TOUCHPOINT_LABEL: Record<Touchpoint, string> = {
  plan: "plan (start of week)",
  checkin: "checkin (mid-week)",
  review: "review (end of week)",
};

export function buildContextMessage(input: ContextInput): Anthropic.MessageParam {
  const { team, person, touchpoint, weekOf, openItems } = input;
  const items = openItems
    .map((t) => {
      const due = t.due ? `, due ${t.due}` : "";
      const state = t.currentState ? `; current state: ${t.currentState}` : "";
      return `- Task ${t.id} (KR ${t.krCode}): ${t.name} [${t.status}${due}${t.blocked ? ", blocked" : ""}]${state}`;
    })
    .join("\n");

  let itemsSection: string;
  if (touchpoint !== "plan") {
    itemsSection = "This week's saved plan: not available yet (saving plans arrives in Phase 2). Ask what they planned.";
  } else if (openItems.length) {
    itemsSection = `Their in-progress tracker items, already listed in the opener:\n${items}`;
  } else {
    itemsSection = "Their in-progress tracker items: none. The opener asked what is on their plate.";
  }

  const text = [
    "<conversation_context>",
    `Team: ${team.teamName}`,
    `Person: ${person.name}${person.role ? ` (${person.role})` : ""}, time zone ${person.timezone}`,
    `Touchpoint: ${TOUCHPOINT_LABEL[touchpoint]}, week of ${shortDate(weekOf)}`,
    itemsSection,
    "</conversation_context>",
    "The system has sent the opener below on your behalf. Continue the conversation from the person's reply.",
  ].join("\n");

  return { role: "user", content: [{ type: "text", text, cache_control: ONE_HOUR }] };
}

/** A user turn: a timestamp block (the person's local time) followed by what they typed. */
export function buildUserTurn(text: string, at: Date, timeZone: string): Anthropic.MessageParam {
  return {
    role: "user",
    content: [
      { type: "text", text: `[${localStamp(at, timeZone)}]` },
      { type: "text", text },
    ],
  };
}
