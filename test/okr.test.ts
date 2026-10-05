import { describe, expect, it } from "vitest";
import { findPerson, openItemsFor, renderOkrSnapshot } from "../src/domain/okr.js";
import { team, tracker } from "./helpers.js";

describe("renderOkrSnapshot", () => {
  it("is byte-identical when rows arrive in a different order (cache-safe)", () => {
    const shuffled = { ...tracker, rows: [...tracker.rows].reverse() };
    expect(renderOkrSnapshot(shuffled, team)).toBe(renderOkrSnapshot(tracker, team));
  });

  it("sorts KR codes numerically (1.2 before 1.10)", () => {
    const text = renderOkrSnapshot(tracker, team);
    expect(text.indexOf("KR 1.2:")).toBeLessThan(text.indexOf("KR 1.10:"));
  });

  it("starts with the team's remit, so field vocabulary is read in context", () => {
    expect(renderOkrSnapshot(tracker, team)).toMatch(/^# Team: Test team\n\nRemit: Tests\.\n/);
  });

  it("leaves out proposed and rejected rows", () => {
    const text = renderOkrSnapshot(tracker, team);
    expect(text).not.toContain("Proposed task");
    expect(text).not.toContain("Rejected KR");
    expect(text).toContain("Agreement rate");
  });

  it("shows owners by name and marks blocked tasks", () => {
    const text = renderOkrSnapshot(tracker, team);
    expect(text).toContain("Task t-001: Sooner task (Ann; In progress; due 2026-10-09; BLOCKED)");
  });
});

describe("openItemsFor", () => {
  it("returns only in-progress tasks, soonest due first, skipping done, not-started and proposed", () => {
    expect(openItemsFor("ann", tracker).map((r) => r.id)).toEqual(["t-001", "t-002"]);
  });

  it("caps the list at three", () => {
    const many = {
      ...tracker,
      rows: [1, 2, 3, 4].map((n) => ({ ...tracker.rows[5]!, id: `t-10${n}`, due: `2026-10-1${n}` })),
    };
    expect(openItemsFor("ann", many).map((r) => r.id)).toEqual(["t-101", "t-102", "t-103"]);
  });

  it("returns nothing for someone with no tasks", () => {
    expect(openItemsFor("lead", tracker)).toEqual([]);
  });

  it("offers a shared task to its primary owner only", () => {
    const shared = { ...tracker, rows: [{ ...tracker.rows[5]!, id: "t-200", owners: ["bob", "ann"] }] };
    expect(openItemsFor("bob", shared).map((r) => r.id)).toEqual(["t-200"]);
    expect(openItemsFor("ann", shared)).toEqual([]);
  });
});

describe("findPerson", () => {
  it("is case-insensitive on the id and explains unknown ids", () => {
    expect(findPerson(team, "ANN").name).toBe("Ann");
    expect(() => findPerson(team, "zed")).toThrow(/Known ids: lead, ann, bob/);
  });
});
