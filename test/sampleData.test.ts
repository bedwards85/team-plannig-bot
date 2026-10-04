import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTeam, loadTracker } from "../src/config.js";
import { activeRows, openItemsFor, renderOkrSnapshot } from "../src/domain/okr.js";
import { PersonasFileSchema, RefusalFileSchema } from "../src/domain/schemas.js";

// The repo is public: these files must be fictional and internally consistent.

const team = loadTeam("config/team.sample.yaml");
const tracker = loadTracker("fixtures/q4-tracker.sample.json");
const personas = PersonasFileSchema.parse(JSON.parse(readFileSync("eval/personas.json", "utf8"))).personas;
const refusals = RefusalFileSchema.parse(JSON.parse(readFileSync("eval/refusal-prompts.json", "utf8"))).prompts;
const ids = new Set(team.people.map((p) => p.id));

describe("sample data", () => {
  it("only references people who exist in the sample team", () => {
    for (const row of tracker.rows) for (const owner of row.owners) expect(ids, `${row.id} owner`).toContain(owner);
    for (const p of personas) expect(ids, p.id).toContain(p.personId);
    for (const r of refusals) expect(ids, r.id).toContain(r.personId);
  });

  it("links every task to a KR that exists", () => {
    const krIds = new Set(tracker.rows.filter((r) => r.type === "KR").map((r) => r.id));
    for (const t of tracker.rows.filter((r) => r.type === "Task")) {
      expect(krIds, `${t.id} parent`).toContain(t.parentKrId);
    }
  });

  it("gives every non-lead team member something to carry over on Monday", () => {
    for (const p of team.people.filter((p) => p.manager)) {
      expect(openItemsFor(p.id, tracker).length, p.id).toBeGreaterThan(0);
    }
  });

  it("includes proposed/rejected rows so filtering is exercised", () => {
    expect(activeRows(tracker.rows).length).toBeLessThan(tracker.rows.length);
  });

  it("has the 10 personas and 20 refusal prompts the Phase 1 check expects", () => {
    expect(personas).toHaveLength(10);
    expect(refusals).toHaveLength(20);
    expect(new Set(personas.map((p) => p.id)).size).toBe(10);
  });

  it("keeps the OKR snapshot big enough to cache (Sonnet 5.5 minimum is 512 tokens)", () => {
    // Rough check: about 4 characters per token.
    expect(renderOkrSnapshot(tracker, team).length / 4).toBeGreaterThan(512);
  });

  it("contains no links or IDs from a real workspace", () => {
    const blob = [
      readFileSync("config/team.sample.yaml", "utf8"),
      readFileSync("fixtures/q4-tracker.sample.json", "utf8"),
      readFileSync("eval/personas.json", "utf8"),
      readFileSync("eval/refusal-prompts.json", "utf8"),
      readFileSync("prompts/coach.md", "utf8"),
    ].join("\n");
    expect(blob).not.toMatch(/collection:\/\/|notion\.so|teams\.microsoft\.com|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
  });
});
