import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, ProviderResponse, RenderedRequest, TextBlock, ToolUseBlock } from "./types.js";

export interface StreamCallbacks {
  onText?: (delta: string) => void;
}

/**
 * Pluggable model provider. The engine hands it the exact RenderedRequest it
 * will log; the provider must send that tuple verbatim (no hidden rewriting),
 * otherwise the exactness guarantee breaks.
 */
export interface Provider {
  stream(
    request: RenderedRequest,
    opts: { signal?: AbortSignal } & StreamCallbacks,
  ): Promise<ProviderResponse>;
}

/**
 * Anthropic reference provider.
 *
 * Determinism pinning: replayed history is never re-sent to the model (we
 * replay stored responses verbatim), but fresh generations after a fork
 * should target a pinned model. Configure sessions with dated snapshot ids
 * where available; floating aliases are rejected when `strictPinning` is on.
 */
export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private strictPinning: boolean;

  constructor(opts: { apiKey?: string; strictPinning?: boolean } = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.strictPinning = opts.strictPinning ?? false;
  }

  async stream(
    request: RenderedRequest,
    opts: { signal?: AbortSignal } & StreamCallbacks,
  ): Promise<ProviderResponse> {
    if (this.strictPinning && !/\d{8}$/.test(request.model_id)) {
      throw new Error(
        `model_id "${request.model_id}" is a floating alias; strict pinning requires a dated snapshot id`,
      );
    }
    const stream = this.client.messages.stream(
      {
        model: request.model_id,
        max_tokens: 16000,
        system: request.system_prompt || undefined,
        tools: request.tools.length
          ? request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema as Anthropic.Tool.InputSchema,
            }))
          : undefined,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content as Anthropic.ContentBlockParam[],
        })),
      },
      { signal: opts.signal },
    );
    stream.on("text", (delta) => opts.onText?.(delta));
    const message = await stream.finalMessage();
    return {
      id: message.id,
      model: message.model,
      stop_reason: message.stop_reason ?? "end_turn",
      content: message.content.filter(
        (b): b is Anthropic.TextBlock | Anthropic.ToolUseBlock =>
          b.type === "text" || b.type === "tool_use",
      ) as (TextBlock | ToolUseBlock)[],
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      },
    };
  }
}

export type MockScript = (request: RenderedRequest) => {
  content: (TextBlock | ToolUseBlock)[];
  stop_reason?: string;
};

/**
 * Deterministic in-process provider for tests and offline development.
 * Default behavior: echo a summary of the last user message. A script can
 * drive tool_use flows.
 */
export class MockProvider implements Provider {
  private counter = 0;
  constructor(
    private script: MockScript = (req) => {
      const last = req.messages[req.messages.length - 1];
      const text =
        last?.content
          .map((b: ContentBlock) => (b.type === "text" ? b.text : `[${b.type}]`))
          .join(" ") ?? "";
      return { content: [{ type: "text", text: `echo: ${text}` }] };
    },
    private delayMs = 0,
  ) {}

  async stream(
    request: RenderedRequest,
    opts: { signal?: AbortSignal } & StreamCallbacks,
  ): Promise<ProviderResponse> {
    const { content, stop_reason } = this.script(request);
    for (const block of content) {
      if (opts.signal?.aborted) throw new Error("aborted");
      if (block.type === "text" && opts.onText) {
        for (const word of block.text.split(/(?<= )/)) {
          if (opts.signal?.aborted) throw new Error("aborted");
          opts.onText(word);
          if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
        }
      }
    }
    if (opts.signal?.aborted) throw new Error("aborted");
    this.counter += 1;
    return {
      id: `mock_${this.counter}`,
      model: request.model_id,
      stop_reason: stop_reason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
      content,
      usage: {
        input_tokens: JSON.stringify(request.messages).length,
        output_tokens: JSON.stringify(content).length,
      },
    };
  }
}
