import { z } from "zod";

// Mirrors the shape of the team's Notion OKR tracker (one table holding both KR
// rows and Task rows). Field names here are the bot's own; the Notion adapter in
// Phase 3 maps real property names onto these via config.

export const OkrStatus = z.enum(["Not started", "In progress", "Done"]);

export const OkrRowSchema = z.object({
  id: z.string(),
  type: z.enum(["KR", "Task"]),
  objective: z.string(),
  krCode: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: OkrStatus,
  blocked: z.boolean().default(false),
  currentState: z.string().optional(),
  due: z.iso.date().optional(),
  owners: z.array(z.string()).default([]),
  parentKrId: z.string().optional(),
  // Rows still awaiting accept/reject in the tracker are not treated as real work.
  source: z.enum(["Existing", "Proposed", "Accepted", "Rejected"]).default("Existing"),
});
export type OkrRow = z.infer<typeof OkrRowSchema>;

export const TrackerFixtureSchema = z.object({
  label: z.string(),
  quarter: z.string(),
  rows: z.array(OkrRowSchema),
});
export type TrackerFixture = z.infer<typeof TrackerFixtureSchema>;

export const PersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().optional(),
  timezone: z.string(),
  manager: z.string().optional(),
});
export type Person = z.infer<typeof PersonSchema>;

export const TeamConfigSchema = z.object({
  teamName: z.string(),
  remit: z.string(),
  people: z.array(PersonSchema).min(1),
});
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

// ---- Eval data ----

export const PersonaSchema = z.object({
  id: z.string(),
  personId: z.string(),
  description: z.string(),
  // Instructions for the simulated team member: how they reply, what they know.
  behaviour: z.string(),
  turns: z.number().int().min(2).max(8),
  expect: z.object({
    // The persona asks the bot to do the work itself; the coach must steer back.
    steerBack: z.boolean().default(false),
    // The coach should get to blockers / people / setup at least once.
    blockerQuestion: z.boolean().default(true),
    // The coach should propose or ask which KR the work supports.
    krLink: z.boolean().default(true),
  }),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const PersonasFileSchema = z.object({ personas: z.array(PersonaSchema).min(1) });

export const RefusalPromptSchema = z.object({
  id: z.string(),
  personId: z.string(),
  text: z.string(),
});
export type RefusalPrompt = z.infer<typeof RefusalPromptSchema>;

export const RefusalFileSchema = z.object({ prompts: z.array(RefusalPromptSchema).min(1) });
