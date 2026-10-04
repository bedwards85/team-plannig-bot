import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  TeamConfigSchema,
  TrackerFixtureSchema,
  type TeamConfig,
  type TrackerFixture,
} from "./domain/schemas.js";

export type ThinkingMode = "adaptive" | "off";

export interface Settings {
  model: string;
  thinking: ThinkingMode;
  teamConfigPath: string;
  trackerPath: string;
  coachPromptPath: string;
}

/** Loads .env (if present) into process.env. Existing variables win. */
export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const thinking = (env.COACH_THINKING ?? "adaptive") as ThinkingMode;
  if (thinking !== "adaptive" && thinking !== "off") {
    throw new Error(`COACH_THINKING must be "adaptive" or "off", got "${thinking}"`);
  }
  return {
    model: env.COACH_MODEL ?? "claude-sonnet-5-5",
    thinking,
    teamConfigPath: env.TEAM_CONFIG ?? "config/team.sample.yaml",
    trackerPath: env.TRACKER_FIXTURE ?? "fixtures/q4-tracker.sample.json",
    coachPromptPath: "prompts/coach.md",
  };
}

export function loadTeam(path: string): TeamConfig {
  return TeamConfigSchema.parse(parseYaml(readFileSync(path, "utf8")));
}

export function loadTracker(path: string): TrackerFixture {
  return TrackerFixtureSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function loadText(path: string): string {
  return readFileSync(path, "utf8");
}

/** True when the SDK will find credentials (key, token, or an `ant auth login` profile). */
export function hasAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) return true;
  return existsSync(join(homedir(), ".config", "anthropic"));
}
