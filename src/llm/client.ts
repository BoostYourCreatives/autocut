import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.ts";

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface LlmMessage {
  role: "user" | "assistant";
  /** String oder Original-Contentblöcke der Antwort (Thinking-Blöcke müssen unverändert zurückgegeben werden) */
  content: string | unknown[];
}

export interface LlmRequest {
  model: string;
  /** Statischer, gecachter Teil (Regeln, Stil, Beispiele, SFX-Index) */
  system: string;
  messages: LlmMessage[];
  /** JSON-Schema für die Antwort (Structured Outputs) */
  schema: Record<string, unknown>;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
}

export interface LlmTurn {
  text: string;
  /** Antwortblöcke unverändert, für den nächsten Turn */
  content: unknown[];
  usage: LlmUsage;
  stopReason: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmTurn>;
}

export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  private structured = true;
  constructor() {
    this.client = new Anthropic();
  }

  async complete(req: LlmRequest): Promise<LlmTurn> {
    const send = (structured: boolean) => {
      const params: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens,
        // Thinking lässt sich bei Opus 5.5 nicht abschalten; Tiefe nur über effort
        thinking: { type: "adaptive" },
        output_config: { effort: req.effort, ...(structured ? { format: { type: "json_schema", schema: req.schema } } : {}) },
        // Cache-Breakpoint hinter dem statischen Teil: Regeln, Beispiele und Index werden pro Lauf nur einmal voll berechnet
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: req.messages,
      };
      return this.client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming);
    };

    let res: Anthropic.Message;
    try {
      res = await send(this.structured);
    } catch (e) {
      if (e instanceof Error && /Could not resolve authentication|authentication_error|invalid x-api-key/i.test(e.message)) {
        throw new Error("Keine gültigen Anthropic-Zugangsdaten: ANTHROPIC_API_KEY in .env oder Umgebung setzen.");
      }
      // Falls die API das Schema ablehnt: einmal ohne Structured Outputs, dann steht das JSON-Format nur im Prompt
      if (this.structured && e instanceof Anthropic.BadRequestError && /schema|output_config|format/i.test(e.message)) {
        this.structured = false;
        res = await send(false);
      } else throw e;
    }

    if (res.stop_reason === "refusal") {
      const d = (res as unknown as { stop_details?: { category?: string | null; explanation?: string } }).stop_details;
      throw new Error(`Claude hat die Anfrage abgelehnt (${d?.category ?? "ohne Kategorie"}): ${d?.explanation ?? ""}`);
    }
    if (res.stop_reason === "max_tokens") {
      throw new Error(`Antwort wurde bei max_tokens=${req.maxTokens} abgeschnitten (Thinking und Plan zusammen). plan.max_tokens in params.json erhöhen.`);
    }
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const u = res.usage as unknown as Record<string, number | null | undefined>;
    return {
      text,
      content: res.content as unknown[],
      stopReason: res.stop_reason ?? "unknown",
      usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_tokens: u.cache_read_input_tokens ?? 0,
        cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

export function costUsd(cfg: Config, model: string, u: LlmUsage): number {
  const p = cfg.pricing.claude[model];
  if (!p) return 0;
  const usd = (u.input_tokens * p.inputPerMTok + u.output_tokens * p.outputPerMTok + u.cache_read_tokens * p.cacheReadPerMTok + u.cache_write_tokens * p.cacheWritePerMTok) / 1e6;
  return Math.round(usd * 10000) / 10000;
}
