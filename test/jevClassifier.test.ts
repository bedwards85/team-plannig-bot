import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONTEXT_TURNS,
  DEFAULT_THRESHOLD,
  JevCalibrationSchema,
  calibrationContextTurns,
  hasJevCredentials,
  JevClassifier,
  loadJevCalibration,
  loadJevQuestions,
  type JevCalibration,
  type JevClassifierOptions,
} from "../src/adapters/jev/JevClassifier.js";
import { REPLY_FLAGS, type ReplyExchange, type ReplyFlag } from "../src/ports/classifier.js";

// A stand-in for fetch that records each request and plays back canned answers,
// so the real SDK code path runs without a key or network.

interface Call {
  url: string;
  headers: Headers;
  body: any;
}

type Reply = Response | ((init: RequestInit) => Promise<Response>);

function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: input, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (!next) throw new Error("fake fetch has no reply");
    return typeof next === "function" ? next(init) : next.clone();
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const RAW: Record<ReplyFlag, number> = {
  did_task: 0.7,
  below_top_level: 0.2,
  several_asks: 0.55,
  filled_in_outcome: 0.05,
  third_party_details: 0.01,
};

function jevAnswer(overrides: { model?: string; answers?: Record<string, unknown>; usage?: unknown } = {}) {
  return {
    model: overrides.model ?? "jev-test-1",
    answers:
      overrides.answers ?? Object.fromEntries(REPLY_FLAGS.map((f) => [f, { type: "noul", noul: RAW[f] }])),
    usage: "usage" in overrides ? overrides.usage : { input_tokens: 812, output_tokens: 0 },
  };
}

const questions = loadJevQuestions();

const calibration: JevCalibration = {
  model: "jev-test-1",
  questionsVersion: questions.version,
  createdAt: "2026-10-05T09:00:00.000Z",
  flags: {
    did_task: { threshold: 0.35, isotonic: [[0, 0.5, 0.1], [0.6, 1, 0.8]] },
    below_top_level: { threshold: 0.4, isotonic: [] },
  },
};

const exchange: ReplyExchange = {
  context: [
    "COACH: What do you want to get done this week?",
    "PERSON: Finish the churn summary.",
    "COACH: Who is it for?",
    "PERSON: Lindiwe, for the ops review.",
    "COACH: When does she need it?",
    "PERSON: Thursday.",
  ],
  reply: "So: churn summary to Lindiwe by Thursday. What is the first step?",
};

function classifier(fetch: JevClassifierOptions["fetch"], options: Partial<JevClassifierOptions> = {}) {
  return new JevClassifier({ questions, apiKey: "test-key", model: "jev-test-1", maxRetries: 0, fetch, ...options });
}

beforeEach(() => {
  // Keep the developer's own settings out of the request under test.
  vi.stubEnv("TYPESAFE_BASE_URL", undefined);
  vi.stubEnv("JEV_MODEL", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("JevClassifier request", () => {
  it("posts to /v1/systemone with the API key as a bearer token", async () => {
    const { fetch, calls } = fakeFetch(json(jevAnswer()));
    await classifier(fetch).flagReply(exchange);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/v1\/systemone$/);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer test-key");
  });

  it("sends the model and all five questions from eval/jev-questions.json", async () => {
    const { fetch, calls } = fakeFetch(json(jevAnswer()));
    await classifier(fetch, { model: "jev-chosen" }).flagReply(exchange);
    const body = calls[0]!.body;
    expect(body.model).toBe("jev-chosen");
    expect(Object.keys(body.questions).sort()).toEqual([...REPLY_FLAGS].sort());
    for (const flag of REPLY_FLAGS) {
      expect(body.questions[flag]).toEqual({
        type: "noul",
        instructions: questions.flags[flag].instructions,
        criteria: { true: questions.flags[flag].criteria.true, false: questions.flags[flag].criteria.false },
      });
    }
  });

  it("uses JEV_MODEL when no model is given, and jev-latest when that is blank or unset", async () => {
    const run = async () => {
      const { fetch, calls } = fakeFetch(json(jevAnswer()));
      await classifier(fetch, { model: undefined }).flagReply(exchange);
      return calls[0]!.body.model;
    };
    expect(await run()).toBe("jev-latest");
    vi.stubEnv("JEV_MODEL", "jev-from-env");
    expect(await run()).toBe("jev-from-env");
    vi.stubEnv("JEV_MODEL", "  ");
    expect(await run()).toBe("jev-latest");
  });

  it("sends the reply and only the last four turns by default", async () => {
    const { fetch, calls } = fakeFetch(json(jevAnswer()));
    await classifier(fetch).flagReply(exchange);
    expect(calls[0]!.body.state).toEqual({
      conversation_so_far: exchange.context.slice(2),
      reply_to_check: exchange.reply,
    });
  });

  it("honours contextTurns: fewer, more than there are, or 0 for the whole conversation", async () => {
    const sent = async (contextTurns: number) => {
      const { fetch, calls } = fakeFetch(json(jevAnswer()));
      await classifier(fetch, { contextTurns }).flagReply(exchange);
      return calls[0]!.body.state.conversation_so_far;
    };
    expect(await sent(2)).toEqual(exchange.context.slice(4));
    expect(await sent(0)).toEqual(exchange.context);
    expect(await sent(50)).toEqual(exchange.context);
    expect(await sent(Number.POSITIVE_INFINITY)).toEqual(exchange.context);
  });
});

describe("JevClassifier context setting", () => {
  const sent = async (options: Partial<JevClassifierOptions>) => {
    const { fetch, calls } = fakeFetch(json(jevAnswer()));
    const jev = classifier(fetch, options);
    await jev.flagReply(exchange);
    return { turns: jev.contextTurns, sent: calls[0]!.body.state.conversation_so_far };
  };

  it("sends the last 4 turns with no calibration", async () => {
    expect(await sent({})).toEqual({ turns: 4, sent: exchange.context.slice(2) });
    expect(await sent({ calibration: null })).toEqual({ turns: 4, sent: exchange.context.slice(2) });
    expect(DEFAULT_CONTEXT_TURNS).toBe(4);
  });

  it("takes the setting the calibration was made with when none is given", async () => {
    expect(await sent({ calibration: { ...calibration, contextTurns: 0 } })).toEqual({ turns: 0, sent: exchange.context });
    expect(await sent({ calibration: { ...calibration, contextTurns: 2 } })).toEqual({ turns: 2, sent: exchange.context.slice(4) });
  });

  it("treats a calibration file from before the setting was recorded as 4", async () => {
    const old = JevCalibrationSchema.parse({ model: "jev-test-1", questionsVersion: questions.version, createdAt: "2026-10-01T09:00:00.000Z", flags: {} });
    expect(old.contextTurns).toBeUndefined();
    expect(await sent({ calibration: old })).toEqual({ turns: 4, sent: exchange.context.slice(2) });
    expect(calibrationContextTurns(old)).toBe(4);
    expect(calibrationContextTurns(null)).toBe(4);
  });

  it("lets an explicit setting win over the calibration's", async () => {
    expect(await sent({ calibration: { ...calibration, contextTurns: 0 }, contextTurns: 3 })).toEqual({ turns: 3, sent: exchange.context.slice(3) });
  });

  it("keeps the calibration's setting even when that calibration is set aside for other questions", async () => {
    const jev = classifier(fakeFetch().fetch, { calibration: { ...calibration, questionsVersion: "2026-09-01.1", contextTurns: 0 } });
    expect(jev.contextTurns).toBe(0);
    expect(jev.thresholdFor("did_task")).toBe(DEFAULT_THRESHOLD);
  });

  it("reports Infinity as 0, so run files can record it", () => {
    expect(classifier(fakeFetch().fetch, { contextTurns: Number.POSITIVE_INFINITY }).contextTurns).toBe(0);
  });

  it("accepts only a whole number of 0 or more in the calibration file", () => {
    expect(JevCalibrationSchema.safeParse({ ...calibration, contextTurns: 0 }).success).toBe(true);
    expect(JevCalibrationSchema.safeParse({ ...calibration, contextTurns: 6 }).success).toBe(true);
    expect(JevCalibrationSchema.safeParse({ ...calibration, contextTurns: -1 }).success).toBe(false);
    expect(JevCalibrationSchema.safeParse({ ...calibration, contextTurns: 2.5 }).success).toBe(false);
    expect(JevCalibrationSchema.safeParse({ ...calibration, contextTurns: "4" }).success).toBe(false);
  });
});

describe("JevClassifier answers", () => {
  it("returns the probabilities, model, tokens and time", async () => {
    const { fetch } = fakeFetch(json(jevAnswer()));
    const result = await classifier(fetch).flagReply(exchange);
    expect(result).not.toBeNull();
    expect(result!.probabilities).toEqual(RAW);
    expect(result!.model).toBe("jev-test-1");
    expect(result!.inputTokens).toBe(812);
    expect(result!.ms).toBeGreaterThanOrEqual(0);
  });

  it("counts zero tokens when the answer has no usage", async () => {
    const { fetch } = fakeFetch(json(jevAnswer({ usage: undefined })));
    const result = await classifier(fetch).flagReply(exchange);
    expect(result!.inputTokens).toBe(0);
  });

  it("uses the 0.5 threshold with no calibration", () => {
    const jev = classifier(fakeFetch().fetch);
    for (const flag of REPLY_FLAGS) expect(jev.thresholdFor(flag)).toBe(DEFAULT_THRESHOLD);
    expect(DEFAULT_THRESHOLD).toBe(0.5);
    expect(jev.questionsVersion).toBe(questions.version);
    expect(jev.notes.size).toBe(0);
  });
});

describe("JevClassifier calibration", () => {
  it("applies the isotonic map and thresholds when question version and model both match", async () => {
    const { fetch } = fakeFetch(json(jevAnswer()));
    const jev = classifier(fetch, { calibration });
    const result = await jev.flagReply(exchange);
    expect(result!.probabilities.did_task).toBe(0.8); // 0.7 falls in the [0.6, 1] block
    expect(result!.probabilities.below_top_level).toBe(RAW.below_top_level); // empty map: left alone
    expect(result!.probabilities.several_asks).toBe(RAW.several_asks); // no entry: left alone
    expect(jev.thresholdFor("did_task")).toBe(0.35);
    expect(jev.thresholdFor("below_top_level")).toBe(0.4);
    expect(jev.thresholdFor("several_asks")).toBe(DEFAULT_THRESHOLD);
    expect(jev.notes.size).toBe(0);
  });

  it("ignores calibration made for other questions, with a note", async () => {
    const { fetch } = fakeFetch(json(jevAnswer()));
    const jev = classifier(fetch, { calibration: { ...calibration, questionsVersion: "2026-09-01.1" } });
    expect(jev.thresholdFor("did_task")).toBe(DEFAULT_THRESHOLD);
    const result = await jev.flagReply(exchange);
    expect(result!.probabilities).toEqual(RAW);
    expect(jev.notes.size).toBe(1);
    const [note] = [...jev.notes];
    expect(note).toContain("2026-09-01.1");
    expect(note).toContain(questions.version);
    expect(note).toContain("jev:eval");
  });

  it("ignores calibration made for another model, with a note, and falls back to the 0.5 threshold", async () => {
    const { fetch } = fakeFetch(json(jevAnswer({ model: "jev-test-2" })));
    const jev = classifier(fetch, { calibration });
    expect(jev.thresholdFor("did_task")).toBe(0.35); // not known to be wrong until Jev answers
    const result = await jev.flagReply(exchange);
    expect(result!.model).toBe("jev-test-2");
    expect(result!.probabilities).toEqual(RAW);
    const notes = [...jev.notes].join("\n");
    expect(notes).toMatch(/jev-test-1.*jev-test-2/);
    expect(notes).toContain("jev:eval"); // says what to do about it
    // The thresholds were chosen on recalibrated scores, so they must not be used against raw ones.
    expect(jev.thresholdFor("did_task")).toBe(DEFAULT_THRESHOLD);

    await jev.flagReply(exchange);
    expect(jev.notes.size).toBe(1);
  });
});

describe("JevClassifier.validated", () => {
  const withStatus: JevCalibration = {
    ...calibration,
    flags: {
      did_task: { ...calibration.flags.did_task!, status: "pass" },
      below_top_level: { ...calibration.flags.below_top_level!, status: "fail" },
      several_asks: { threshold: 0.5, isotonic: [] }, // a file from before results were recorded
    },
  };

  it("is true only for flags the calibration in use marks as passed by jev:eval", () => {
    const jev = classifier(fakeFetch().fetch, { calibration: withStatus });
    expect(REPLY_FLAGS.filter((f) => jev.validated(f))).toEqual(["did_task"]);
  });

  it("is false for every flag without a calibration", () => {
    const jev = classifier(fakeFetch().fetch);
    expect(REPLY_FLAGS.some((f) => jev.validated(f))).toBe(false);
  });

  it("is false once the calibration is set aside, for other questions or another model", async () => {
    expect(classifier(fakeFetch().fetch, { calibration: { ...withStatus, questionsVersion: "2026-09-01.1" } }).validated("did_task")).toBe(false);
    const { fetch } = fakeFetch(json(jevAnswer({ model: "jev-test-2" })));
    const jev = classifier(fetch, { calibration: withStatus });
    expect(jev.validated("did_task")).toBe(true); // not known to be wrong until Jev answers
    await jev.flagReply(exchange);
    expect(jev.validated("did_task")).toBe(false);
  });

  it("reads the status from the calibration file, accepting only pass or fail", () => {
    expect(JevCalibrationSchema.parse(withStatus).flags.did_task!.status).toBe("pass");
    const bad = { ...calibration, flags: { did_task: { threshold: 0.3, isotonic: [], status: "maybe" } } };
    expect(JevCalibrationSchema.safeParse(bad).success).toBe(false);
  });
});

describe("JevClassifier failures return null, never throw", () => {
  it("on HTTP 500", async () => {
    const { fetch, calls } = fakeFetch(json({ error: "boom" }, 500));
    await expect(classifier(fetch).flagReply(exchange)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("on a bad API key", async () => {
    const { fetch } = fakeFetch(json({ error: "invalid key" }, 401));
    await expect(classifier(fetch).flagReply(exchange)).resolves.toBeNull();
  });

  it("on a network error", async () => {
    const fetch = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    await expect(classifier(fetch).flagReply(exchange)).resolves.toBeNull();
  });

  it("on a missing answer", async () => {
    const answers = Object.fromEntries(
      REPLY_FLAGS.filter((f) => f !== "several_asks").map((f) => [f, { type: "noul", noul: RAW[f] }]),
    );
    const { fetch } = fakeFetch(json(jevAnswer({ answers })));
    await expect(classifier(fetch).flagReply(exchange)).resolves.toBeNull();
  });

  it("on an answer that is not a number", async () => {
    for (const bad of ["0.7", null, true, { value: 0.7 }]) {
      const answers = Object.fromEntries(REPLY_FLAGS.map((f) => [f, { type: "noul", noul: f === "did_task" ? bad : RAW[f] }]));
      const { fetch } = fakeFetch(json(jevAnswer({ answers })));
      await expect(classifier(fetch).flagReply(exchange)).resolves.toBeNull();
    }
  });

  it("on an answer outside 0 to 1", async () => {
    for (const bad of [-0.1, 1.5]) {
      const answers = Object.fromEntries(REPLY_FLAGS.map((f) => [f, { type: "noul", noul: f === "did_task" ? bad : RAW[f] }]));
      const { fetch } = fakeFetch(json(jevAnswer({ answers })));
      await expect(classifier(fetch).flagReply(exchange)).resolves.toBeNull();
    }
    // The ends themselves are fine.
    const edges = Object.fromEntries(REPLY_FLAGS.map((f, i) => [f, { type: "noul", noul: i % 2 ? 1 : 0 }]));
    const { fetch } = fakeFetch(json(jevAnswer({ answers: edges })));
    expect(await classifier(fetch).flagReply(exchange)).not.toBeNull();
  });

  it("on a response with no answers at all", async () => {
    const { fetch } = fakeFetch(json({ model: "jev-test-1" }));
    await expect(classifier(fetch).flagReply(exchange)).resolves.toBeNull();
  });

  it("on timeout", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
      });
    const { fetch, calls } = fakeFetch(hang);
    const started = performance.now();
    await expect(classifier(fetch, { timeoutMs: 50 }).flagReply(exchange)).resolves.toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(calls).toHaveLength(1);
  });

  it("when the caller cancels", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
      });
    const { fetch } = fakeFetch(hang);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(classifier(fetch, { timeoutMs: 5_000 }).flagReply(exchange, controller.signal)).resolves.toBeNull();
  });
});

describe("JevClassifier retries", () => {
  it("retries a server error when maxRetries allows it", async () => {
    // retry-after-ms: 0 keeps the test fast; the SDK honours it instead of backing off.
    const { fetch, calls } = fakeFetch(json({ error: "busy" }, 503, { "retry-after-ms": "0" }), json(jevAnswer()));
    const result = await classifier(fetch, { maxRetries: 1 }).flagReply(exchange);
    expect(result).not.toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe("Jev helpers", () => {
  it("hasJevCredentials needs a non-blank TYPESAFE_API_KEY", () => {
    expect(hasJevCredentials({})).toBe(false);
    expect(hasJevCredentials({ TYPESAFE_API_KEY: "   " })).toBe(false);
    expect(hasJevCredentials({ TYPESAFE_API_KEY: "ts-key" })).toBe(true);
  });

  it(".env.example has a blank, uncommented TYPESAFE_API_KEY line to fill in, like ANTHROPIC_API_KEY", () => {
    const lines = readFileSync(".env.example", "utf8").split(/\r?\n/);
    expect(lines).toContain("ANTHROPIC_API_KEY=");
    expect(lines).toContain("TYPESAFE_API_KEY=");
    expect(lines).toContain("# JEV_MODEL=jev-latest");
    // Left blank, it reads as no key, so the scripts say how to add one.
    expect(hasJevCredentials({ TYPESAFE_API_KEY: "" })).toBe(false);
  });

  it("loadJevCalibration returns null when there is no file, and reads one that exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-cal-"));
    expect(loadJevCalibration(join(dir, "missing.json"))).toBeNull();
    const path = join(dir, "jev-calibration.json");
    writeFileSync(path, JSON.stringify(calibration));
    expect(loadJevCalibration(path)).toEqual(calibration);
    writeFileSync(path, JSON.stringify({ ...calibration, contextTurns: 0 }));
    expect(loadJevCalibration(path)!.contextTurns).toBe(0);
  });

  it("loadJevQuestions has all five flags", () => {
    expect(Object.keys(questions.flags).sort()).toEqual([...REPLY_FLAGS].sort());
    expect(questions.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});
