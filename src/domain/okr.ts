import type { OkrRow, Person, TeamConfig, TrackerFixture } from "./schemas.js";

/** Rows the coach treats as real work: anything not still proposed or rejected. */
export function activeRows(rows: OkrRow[]): OkrRow[] {
  return rows.filter((r) => r.source !== "Proposed" && r.source !== "Rejected");
}

function compareKrCode(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

function byKrThenId(a: OkrRow, b: OkrRow): number {
  return compareKrCode(a.krCode, b.krCode) || a.id.localeCompare(b.id);
}

function names(ids: string[], team: TeamConfig): string {
  if (ids.length === 0) return "unassigned";
  return ids.map((id) => team.people.find((p) => p.id === id)?.name ?? id).join(", ");
}

/**
 * Renders the team's OKRs as plain text for the system prompt.
 *
 * The output must be byte-identical for the same tracker state, because it sits
 * inside the cached prompt prefix: rows are sorted, and nothing time-dependent
 * (today's date, "last updated") is included.
 */
export function renderOkrSnapshot(tracker: TrackerFixture, team: TeamConfig): string {
  const rows = activeRows(tracker.rows);
  const krs = rows.filter((r) => r.type === "KR").sort(byKrThenId);
  const tasks = rows.filter((r) => r.type === "Task").sort(byKrThenId);
  const objectives = [...new Set(krs.map((k) => k.objective))];

  const lines: string[] = [`# Team OKRs: ${tracker.label}`, ""];
  for (const objective of objectives) {
    lines.push(`## Objective ${objective}`);
    for (const kr of krs.filter((k) => k.objective === objective)) {
      lines.push(`- KR ${kr.krCode}: ${kr.name} (owner: ${names(kr.owners, team)}; status: ${kr.status})`);
      if (kr.description) lines.push(`  ${kr.description}`);
      for (const t of tasks.filter((t) => t.krCode === kr.krCode)) {
        const due = t.due ? `; due ${t.due}` : "";
        const blocked = t.blocked ? "; BLOCKED" : "";
        lines.push(`  - Task ${t.id}: ${t.name} (${names(t.owners, team)}; ${t.status}${due}${blocked})`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * A person's open tracker tasks, most urgent first: the Monday opener offers
 * these as "still open". Phase 2 adds unfinished items from last week's plan.
 */
export function openItemsFor(personId: string, tracker: TrackerFixture, limit = 3): OkrRow[] {
  return activeRows(tracker.rows)
    .filter((r) => r.type === "Task" && r.status !== "Done" && r.owners.includes(personId))
    .sort((a, b) => {
      // In-progress work first, then by due date (undated last), then id.
      const prog = Number(b.status === "In progress") - Number(a.status === "In progress");
      if (prog !== 0) return prog;
      const ad = a.due ?? "9999-12-31";
      const bd = b.due ?? "9999-12-31";
      return ad.localeCompare(bd) || a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

export function findPerson(team: TeamConfig, id: string): Person {
  const person = team.people.find((p) => p.id === id.toLowerCase());
  if (!person) {
    const ids = team.people.map((p) => p.id).join(", ");
    throw new Error(`No person "${id}" in the team config. Known ids: ${ids}`);
  }
  return person;
}
