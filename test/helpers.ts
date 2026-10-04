import type { TeamConfig, TrackerFixture } from "../src/domain/schemas.js";
import { TeamConfigSchema, TrackerFixtureSchema } from "../src/domain/schemas.js";

export const team: TeamConfig = TeamConfigSchema.parse({
  teamName: "Test team",
  remit: "Tests.",
  people: [
    { id: "lead", name: "Lee", timezone: "Africa/Johannesburg" },
    { id: "ann", name: "Ann", role: "Analyst", timezone: "Africa/Nairobi", manager: "lead" },
    { id: "bob", name: "Bob", timezone: "Africa/Johannesburg", manager: "lead" },
  ],
});

export const tracker: TrackerFixture = TrackerFixtureSchema.parse({
  label: "Test tracker",
  quarter: "Q4 2026",
  rows: [
    { id: "kr-2.1", type: "KR", objective: "2 Data model", krCode: "2.1", name: "Model live", status: "In progress", owners: ["bob"] },
    { id: "kr-1.10", type: "KR", objective: "1 Measure", krCode: "1.10", name: "Tenth KR", status: "Not started", owners: ["ann"] },
    { id: "kr-1.2", type: "KR", objective: "1 Measure", krCode: "1.2", name: "Agreement rate", status: "In progress", owners: ["ann"] },
    { id: "t-003", type: "Task", objective: "1 Measure", krCode: "1.2", name: "Undated task", status: "Not started", owners: ["ann"], parentKrId: "kr-1.2" },
    { id: "t-002", type: "Task", objective: "1 Measure", krCode: "1.2", name: "Later task", status: "In progress", due: "2026-10-20", owners: ["ann"], parentKrId: "kr-1.2" },
    { id: "t-001", type: "Task", objective: "1 Measure", krCode: "1.2", name: "Sooner task", status: "In progress", due: "2026-10-09", owners: ["ann"], parentKrId: "kr-1.2", currentState: "waiting on access", blocked: true },
    { id: "t-004", type: "Task", objective: "2 Data model", krCode: "2.1", name: "Done task", status: "Done", owners: ["ann"], parentKrId: "kr-2.1" },
    { id: "t-005", type: "Task", objective: "2 Data model", krCode: "2.1", name: "Proposed task", status: "Not started", owners: ["ann"], parentKrId: "kr-2.1", source: "Proposed" },
    { id: "t-006", type: "Task", objective: "2 Data model", krCode: "2.1", name: "Not started soon", status: "Not started", due: "2026-10-07", owners: ["ann"], parentKrId: "kr-2.1" },
    { id: "kr-9.9", type: "KR", objective: "9 Rejected", krCode: "9.9", name: "Rejected KR", status: "Not started", owners: [], source: "Rejected" },
  ],
});

/** Monday 12 Oct 2026, 06:30 UTC = 09:30 in Nairobi, 08:30 in Johannesburg. */
export const MONDAY = new Date("2026-10-12T06:30:00Z");
