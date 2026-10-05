import { readFileSync, existsSync } from "node:fs";
import { TypeSafeClient, type NoulQuestion } from "@typesafe-ai/sdk";
import { z } from "zod";
import { applyIsotonic, type IsotonicBlock } from "../../eval/jevMetrics.js";
import {
  REPLY_FLAGS,
  type ClassifierPort,
  type FlagProbabilities,
  type FlagResult,
  type ReplyExchange,
  type ReplyFlag,
} from "../../ports/classifier.js";

const QuestionSchema = z.object({
  instructions: z.string(),
  criteria: z.object({ true: z.string(), false: z.string() }),
});

export const JevQuestionsSchema = z.object({
  version: z.string(),
  about: z.string().optional(),
  flags: z.object(Object.fromEntries(REPLY_FLAGS.map((f) => [f, QuestionSchema])) as Record<ReplyFlag, typeof QuestionSchema>),
});
export type JevQuestions = z.infer<typeof JevQuestionsSchema>;

const FlagCalibrationSchema = z.object({
  threshold: z.number().min(0).max(1),
  isotonic: z.array(z.tuple([z.number(), z.number(), z.number()])),
});

/** Written by `npm run jev:eval`: per-flag recalibration and thresholds, valid for one model and question version. */
export const JevCalibrationSchema = z.object({
  model: z.string(),
  questionsVersion: z.string(),
  createdAt: z.string(),
  flags: z.partialRecord(z.enum(REPLY_FLAGS), FlagCalibrationSchema),
});
export type JevCalibration = z.infer<typeof JevCalibrationSchema>;

export const JEV_QUESTIONS_PATH = "eval/jev-questions.json";
export const JEV_CALIBRATION_PATH = "eval/jev-calibration.json";

export function loadJevQuestions(path = JEV_QUESTIONS_PATH): JevQuestions {
  return JevQuestionsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function loadJevCalibration(path = JEV_CALIBRATION_PATH): JevCalibration | null {
  if (!existsSync(path)) return null;
  return JevCalibrationSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function hasJevCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TYPESAFE_API_KEY?.trim());
}

/** Before a calibration file exists, a flag counts when Jev says yes with probability 0.5 or more. */
export const DEFAULT_THRESHOLD = 0.5;

export interface JevClassifierOptions {
  questions: JevQuestions;
  /** Applied only if it was made for the same question version (and, at run time, the same model). */
  calibration?: JevCalibration | null;
  model?: string;
  /** Per-attempt timeout. The eval can wait; a live monitor should give up fast. */
  timeoutMs?: number;
  maxRetries?: number;
  /** How many earlier turns go into the state. Fewer, relevant turns read better than a whole transcript. */
  contextTurns?: number;
  /** For tests: a stand-in for the global fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  apiKey?: string;
}

/** Asks Jev (TypeSafe AI) the yes/no reply checks in one request. */
export class JevClassifier implements ClassifierPort {
  readonly name = "jev";
  /** Why calibration was not applied, if it wasn't. Shown once by the scripts. */
  readonly notes = new Set<string>();
  private readonly client: TypeSafeClient;
  private readonly questions: Record<ReplyFlag, NoulQuestion>;
  private readonly calibration: JevCalibration | null;
  private readonly contextTurns: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: JevClassifierOptions) {
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      defaultModel: options.model ?? process.env.JEV_MODEL ?? "jev-latest",
      timeout: options.timeoutMs ?? 10_000,
      retry: { maxRetries: options.maxRetries ?? 2 },
      logLevel: "off",
      fetch: options.fetch,
    });
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.contextTurns = options.contextTurns ?? 4;
    this.questions = Object.fromEntries(
      REPLY_FLAGS.map((f) => [f, { type: "noul", ...options.questions.flags[f] } satisfies NoulQuestion]),
    ) as Record<ReplyFlag, NoulQuestion>;

    const cal = options.calibration ?? null;
    if (cal && cal.questionsVersion !== options.questions.version) {
      this.notes.add(
        `Calibration is for questions ${cal.questionsVersion}, not ${options.questions.version}: using raw probabilities and threshold ${DEFAULT_THRESHOLD}. Rerun npm run jev:eval.`,
      );
      this.calibration = null;
    } else {
      this.calibration = cal;
    }
  }

  get questionsVersion(): string {
    return this.options.questions.version;
  }

  thresholdFor(flag: ReplyFlag): number {
    return this.calibration?.flags[flag]?.threshold ?? DEFAULT_THRESHOLD;
  }

  async flagReply(exchange: ReplyExchange, signal?: AbortSignal): Promise<FlagResult | null> {
    const started = performance.now();
    try {
      const result = await this.client.systemOne(
        {
          state: { conversation_so_far: exchange.context.slice(-this.contextTurns), reply_to_check: exchange.reply },
          questions: this.questions,
        },
        { signal, timeout: this.timeoutMs },
      );
      const useCalibration = this.calibration !== null && this.calibration.model === result.model;
      if (this.calibration && !useCalibration) {
        this.notes.add(
          `Calibration is for model ${this.calibration.model}, but ${result.model} answered: using raw probabilities and threshold ${DEFAULT_THRESHOLD}.`,
        );
      }
      const probabilities = {} as FlagProbabilities;
      for (const flag of REPLY_FLAGS) {
        const raw = result.answers[flag]?.noul;
        if (typeof raw !== "number" || Number.isNaN(raw)) return null;
        const blocks: IsotonicBlock[] | undefined = useCalibration ? this.calibration!.flags[flag]?.isotonic : undefined;
        probabilities[flag] = blocks?.length ? applyIsotonic(blocks, raw) : raw;
      }
      return { probabilities, model: result.model, ms: performance.now() - started };
    } catch {
      // Unknown, not a verdict: callers fall back to the slower judge or skip the check.
      return null;
    }
  }
}
