import { describe, expect, it } from "vitest";
import { buildContextMessage, buildSystem } from "../src/core/promptAssembly.js";
import { findPerson, openItemsFor } from "../src/domain/okr.js";
import { team, tracker } from "./helpers.js";

describe("prompt assembly", () => {
  it("puts 1-hour cache breakpoints on the coach prompt and the OKR snapshot", () => {
    const system = buildSystem("coach", "okrs");
    expect(system).toEqual([
      { type: "text", text: "coach", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "okrs", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });

  it("puts the person's context in the first user message with its own 1-hour breakpoint", () => {
    const person = findPerson(team, "ann");
    const msg = buildContextMessage({
      team,
      person,
      touchpoint: "plan",
      weekOf: "2026-10-12",
      openItems: openItemsFor("ann", tracker),
    });
    expect(msg.role).toBe("user");
    const blocks = msg.content as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[0]!.text).toContain("Person: Ann (Analyst), time zone Africa/Nairobi");
    expect(blocks[0]!.text).toContain("Touchpoint: plan (start of week), week of 12 Oct");
    expect(blocks[0]!.text).toContain("Task t-001 (KR 1.2): Sooner task [In progress, due 2026-10-09, blocked]; current state: waiting on access");
  });
});
