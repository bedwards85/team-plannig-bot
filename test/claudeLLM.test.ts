import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeLLM } from "../src/adapters/anthropic/ClaudeLLM.js";
import { isRetryable } from "../src/core/conversation.js";
import { FirstTextTimeoutError } from "../src/ports/llm.js";

// A local stand-in for the Messages API that streams canned server-sent events,
// so the real SDK code path runs without a key or network.

type Scenario = { stopReason: "end_turn" | "refusal"; chunks: string[]; delayFirstMs?: number; errorBeforeText?: boolean };
let scenario: Scenario = { stopReason: "end_turn", chunks: [] };
let lastBody: any = null;
let server: Server;
let baseURL = "";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      lastBody = JSON.parse(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse("message_start", {
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: lastBody.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            stop_details: null,
            usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 },
          },
        }),
      );
      if (scenario.delayFirstMs) await new Promise((r) => setTimeout(r, scenario.delayFirstMs));
      if (res.destroyed) return;
      if (scenario.errorBeforeText) {
        // How an overload arrives once the stream is already open (HTTP 200).
        res.write(sse("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
        res.end();
        return;
      }
      res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } }));
      for (const chunk of scenario.chunks) {
        res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } }));
      }
      res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      const refusal = scenario.stopReason === "refusal";
      res.write(
        sse("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: scenario.stopReason,
            stop_sequence: null,
            stop_details: refusal ? { type: "refusal", category: "cyber", explanation: "test" } : null,
          },
          usage: { output_tokens: 9 },
        }),
      );
      res.write(sse("message_stop", { type: "message_stop" }));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function llm(opts: { thinking?: "adaptive" | "off"; firstTextTimeoutMs?: number } = {}) {
  return new ClaudeLLM({ client: new Anthropic({ apiKey: "test-key", baseURL, maxRetries: 0 }), ...opts });
}

const request = {
  system: [{ type: "text" as const, text: "coach", cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }],
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("ClaudeLLM", () => {
  it("sends the low-latency request shape: Sonnet 5.5, adaptive thinking, low effort, 1h tail cache, streaming", async () => {
    scenario = { stopReason: "end_turn", chunks: ["What does ", "done look like?"] };
    await llm().streamTurn(request, () => {});
    expect(lastBody).toMatchObject({
      model: "claude-sonnet-5-5",
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral", ttl: "1h" },
      system: request.system,
      messages: request.messages,
    });
    expect(lastBody.tools).toBeUndefined();
    expect(lastBody.fallbacks).toBeUndefined();
  });

  it("uses between_tools when thinking is switched off", async () => {
    scenario = { stopReason: "end_turn", chunks: ["ok"] };
    await llm({ thinking: "off" }).streamTurn(request, () => {});
    expect(lastBody.thinking).toEqual({ type: "between_tools" });
  });

  it("streams deltas, measures time to first text and reports cache reads", async () => {
    scenario = { stopReason: "end_turn", chunks: ["What does ", "done look like?"] };
    const deltas: string[] = [];
    const result = await llm().streamTurn(request, (d) => deltas.push(d));
    expect(deltas).toEqual(["What does ", "done look like?"]);
    expect(result.text).toBe("What does done look like?");
    expect(result.stopReason).toBe("end_turn");
    expect(result.firstTextMs).toBeGreaterThan(0);
    expect(result.usage).toMatchObject({ cacheReadTokens: 4000, outputTokens: 9 });
    expect(result.content).toEqual([{ type: "text", text: "What does done look like?", citations: null }]);
  });

  it("reports refusals with their category", async () => {
    scenario = { stopReason: "refusal", chunks: ["Partial"] };
    const result = await llm().streamTurn(request, () => {});
    expect(result.stopReason).toBe("refusal");
    expect(result.refusalCategory).toBe("cyber");
  });

  it("surfaces an in-stream overload as a retryable error", async () => {
    scenario = { stopReason: "end_turn", chunks: [], errorBeforeText: true };
    const error = await llm().streamTurn(request, () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Anthropic.APIError);
    expect((error as InstanceType<typeof Anthropic.APIError>).type).toBe("overloaded_error");
    expect(isRetryable(error)).toBe(true);
  });

  it("gives up with FirstTextTimeoutError when no text arrives in time", async () => {
    scenario = { stopReason: "end_turn", chunks: ["late"], delayFirstMs: 500 };
    await expect(llm({ firstTextTimeoutMs: 100 }).streamTurn(request, () => {})).rejects.toBeInstanceOf(FirstTextTimeoutError);
  });
});
