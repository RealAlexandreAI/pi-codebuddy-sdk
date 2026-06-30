/**
 * Provider entry point — pi-claude-bridge pattern.
 *
 * For each Pi turn:
 * 1. Extract the latest user message (strip context-mode injection)
 * 2. Call sdk.query() — stateless, CodeBuddy uses its own system prompt
 * 3. Stream events back to Pi (text, thinking, toolcalls)
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai/compat";
import type {
  Effort,
  Message as CbMessage,
  ThinkingConfig,
} from "@tencent-ai/agent-sdk";

type CodebuddySdk = typeof import("@tencent-ai/agent-sdk");

async function loadSdk(): Promise<CodebuddySdk> {
  return import("@tencent-ai/agent-sdk");
}

// ── helpers ──

function makePartial(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeErrorPartial(model: Model<any>, error: unknown): AssistantMessage {
  return {
    ...makePartial(model),
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

// ── extract user message ──

/**
 * Extract the latest user message from Pi Context.
 * Strips context-mode session state injection.
 *
 * Like pi-claude-bridge's extractUserPrompt() but with context-mode defense.
 */
function extractUserMessage(context: Context): string {
  const msgs = context.messages;

  // Pi injects context-mode state as the LAST user message (after the real one).
  // Search from the end, skip obvious context-mode injections.
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    const raw = contentToText((msgs[i] as any).content);
    if (!raw) continue;

    // Skip messages that are entirely context-mode injection
    if (isContextModeInjection(raw)) continue;

    return stripPiInjection(raw);
  }
  return "Continue.";
}

/** Detect if a user message is a Pi context-mode state injection (not a real message). */
function isContextModeInjection(text: string): boolean {
  const t = text.trim();
  if (t.startsWith("context-mode active.")) return true;
  if (t.includes("<session_state") || t.includes("<session_mode")) return true;
  if (t.startsWith("<summary>") && t.includes("</summary>")) return true;
  return false;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text as string)
    .join("\n");
}

/**
 * Strip context-mode session state that Pi prepends to user messages.
 *
 * Pi injects several formats:
 *   context-mode active. Hierarchy: ...
 *   <session_state source="compaction"> ... </session_state>
 *   <summary>Compacted: ...</summary>
 *
 * Strip all of them, keep only the actual user message.
 */
function stripPiInjection(text: string): string {
  // Fast path
  if (!text.includes("context-mode") && !text.includes("<session_state") && !text.includes("<summary>")) {
    return text;
  }

  // 1. Remove <summary> blocks (compaction summaries contain context-mode state)
  text = text.replace(/<summary>[\s\S]*?<\/summary>\s*/g, "");

  // 2. Remove <session_state> block and everything between "context-mode" and </session_state>
  const sessionEnd = text.lastIndexOf("</session_state>");
  if (sessionEnd >= 0) {
    const after = text.slice(sessionEnd + "</session_state>".length).trimStart();
    if (after) {
      text = after;
    } else {
      // All content was in the session_state block
      const before = text.slice(0, text.indexOf("<session_state")).trim();
      if (before) text = before;
    }
  }

  // 3. Remove "context-mode active." line and everything after until a blank line
  //    Pattern: "context-mode active. ... Hierarchy: ..." followed by blank line, then real message
  const cmRe = /context-mode active\.[\s\S]*?\n\s*\n([\s\S]*)$/;
  const cmMatch = text.match(cmRe);
  if (cmMatch?.[1]?.trim()) {
    text = cmMatch[1].trim();
  }

  // 4. If "context-mode" is still the only content, return empty
  if (text.trim() === "context-mode active." || text.trim().startsWith("context-mode active.")) {
    const afterCm = text.replace(/context-mode active\.[\s\S]*/, "").trim();
    if (afterCm) text = afterCm;
  }

  return text.trim() || text;
}

// ── thinking config ──

const THINKING_BUDGETS: Record<string, number> = {
  minimal: 1600, low: 4000, medium: 0, high: 0, xhigh: 32000,
};
const EFFORT_MAP: Record<string, Effort | undefined> = {
  minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh",
};

function buildThinking(reasoning?: SimpleStreamOptions["reasoning"], budgets?: SimpleStreamOptions["thinkingBudgets"]): { thinking?: ThinkingConfig; effort?: Effort } {
  if (!reasoning) return {};
  if (reasoning === "off") return { thinking: { type: "disabled" } };
  const budget = budgets?.[reasoning as keyof typeof budgets] ?? THINKING_BUDGETS[reasoning] ?? 0;
  const effort = EFFORT_MAP[reasoning];
  if (budget > 0) return { thinking: { type: "enabled", budgetTokens: budget }, effort };
  return { thinking: { type: "adaptive" }, effort };
}

// ── usage extraction ──

function extractUsage(msg: CbMessage): Partial<AssistantMessage> | null {
  if (msg.type !== "result" || !msg.usage) return null;
  return {
    usage: {
      input: msg.usage.input_tokens ?? 0,
      output: msg.usage.output_tokens ?? 0,
      cacheRead: msg.usage.cache_read_input_tokens ?? 0,
      cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
      totalTokens:
        (msg.usage.input_tokens ?? 0) +
        (msg.usage.output_tokens ?? 0) +
        (msg.usage.cache_read_input_tokens ?? 0) +
        (msg.usage.cache_creation_input_tokens ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: msg.total_cost_usd ?? 0 },
    },
  };
}

// ── main ──

export function streamCodebuddy(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial = makePartial(model);

  queueMicrotask(async () => {
    try {
      stream.push({ type: "start", partial });

      const sdk = await loadSdk();
      const userText = extractUserMessage(context);

      const { thinking, effort } = buildThinking(options?.reasoning, options?.thinkingBudgets);

      const q = sdk.query({
        prompt: userText,
        options: {
          model: model.id,
          permissionMode: "bypassPermissions",
          maxTurns: 100,
          thinking,
          effort,
          includePartialMessages: true,
        },
      });

      // ── abort ──
      let aborted = false;
      const onAbort = async () => {
        if (aborted) return;
        aborted = true;
        try { await q.interrupt(); } catch { /* best-effort */ }
        partial.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: partial });
      };
      if (options?.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) { await onAbort(); return; }
      }

      // ── per-block tracking (for stream_event delta accumulation) ──
      type BlockKind = "text" | "thinking" | "tool_use" | "redacted_thinking";
      const blockKind = new Map<number, BlockKind>();
      const blockAccum = new Map<number, string>();
      const blockMeta = new Map<number, { id: string; name: string; signature?: string }>();

      let hasStreamEvents = false;

      function onStart(idx: number, kind: BlockKind, init: string, meta?: { id: string; name: string; signature?: string }) {
        blockKind.set(idx, kind);
        blockAccum.set(idx, init);
        if (meta) blockMeta.set(idx, meta);

        if (kind === "redacted_thinking") {
          const tc: ThinkingContent = { type: "thinking", thinking: "[redacted]", redacted: true, thinkingSignature: meta?.signature };
          partial.content = [...partial.content, tc];
          stream.push({ type: "thinking_start", contentIndex: idx, partial });
          stream.push({ type: "thinking_end", contentIndex: idx, content: "[redacted]", partial });
        } else if (kind === "thinking") {
          const tc: ThinkingContent = { type: "thinking", thinking: init, thinkingSignature: meta?.signature };
          partial.content = [...partial.content, tc];
          stream.push({ type: "thinking_start", contentIndex: idx, partial });
        } else if (kind === "text") {
          partial.content = [...partial.content, { type: "text", text: init }];
          stream.push({ type: "text_start", contentIndex: idx, partial });
        } else if (kind === "tool_use" && meta) {
          partial.content = [...partial.content, { type: "toolCall", id: meta.id, name: meta.name, arguments: {} }];
          stream.push({ type: "toolcall_start", contentIndex: idx, partial });
        }
      }

      function onDelta(idx: number, deltaType: string, value: string) {
        const kind = blockKind.get(idx);
        if (!kind) return;

        if (deltaType === "text_delta" && kind === "text") {
          const next = (blockAccum.get(idx) || "") + value;
          blockAccum.set(idx, next);
          const blocks = [...partial.content];
          blocks[idx] = { type: "text", text: next };
          partial.content = blocks;
          stream.push({ type: "text_delta", contentIndex: idx, delta: value, partial });
        } else if (deltaType === "thinking_delta" && kind === "thinking") {
          const next = (blockAccum.get(idx) || "") + value;
          blockAccum.set(idx, next);
          const blocks = [...partial.content];
          blocks[idx] = { type: "thinking", thinking: next, thinkingSignature: blockMeta.get(idx)?.signature };
          partial.content = blocks;
          stream.push({ type: "thinking_delta", contentIndex: idx, delta: value, partial });
        } else if (deltaType === "input_json_delta" && kind === "tool_use") {
          const json = (blockAccum.get(idx) || "") + value;
          blockAccum.set(idx, json);
          const blocks = [...partial.content];
          try { blocks[idx] = { ...blocks[idx], arguments: JSON.parse(json) }; } catch { /* partial */ }
          partial.content = blocks;
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta: value, partial } as any);
        }
      }

      function onStop(idx: number) {
        const kind = blockKind.get(idx);
        const accum = blockAccum.get(idx) || "";
        if (kind === "text") stream.push({ type: "text_end", contentIndex: idx, content: accum, partial });
        else if (kind === "thinking") stream.push({ type: "thinking_end", contentIndex: idx, content: accum, partial });
        else if (kind === "tool_use") stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: partial.content[idx] as ToolCall, partial });
      }

      // ── iterate ──
      for await (const msg of q) {
        if (aborted) return;

        if (msg.type === "system") {
          if (msg.model) partial.responseModel = msg.model;
          continue;
        }

        // Token-level streaming via stream_event (preferred)
        if (msg.type === "stream_event") {
          hasStreamEvents = true;
          const evt = msg.event;

          if (evt.type === "content_block_start") {
            const b = evt.content_block;
            if (b.type === "text") onStart(evt.index, "text", b.text || "");
            else if (b.type === "thinking") onStart(evt.index, "thinking", b.thinking || "", { id: "", name: "", signature: b.signature });
            else if (b.type === "redacted_thinking") onStart(evt.index, "redacted_thinking", "[redacted]", { id: "", name: "", signature: b.data });
            else if (b.type === "tool_use") onStart(evt.index, "tool_use", JSON.stringify(b.input || {}), { id: b.id, name: b.name });
          } else if (evt.type === "content_block_delta") {
            const d = evt.delta;
            if (d.type === "text_delta") onDelta(evt.index, "text_delta", d.text);
            else if (d.type === "thinking_delta") onDelta(evt.index, "thinking_delta", d.thinking);
            else if (d.type === "input_json_delta") onDelta(evt.index, "input_json_delta", d.partial_json);
          } else if (evt.type === "content_block_stop") {
            onStop(evt.index);
          }
          continue;
        }

        // Fallback: full assistant messages
        if (msg.type === "assistant" && !hasStreamEvents) {
          let ci = 0;
          for (const block of msg.message.content) {
            const idx = ci++;
            if (block.type === "thinking") { onStart(idx, "thinking", block.thinking); onStop(idx); }
            else if (block.type === "redacted_thinking") onStart(idx, "redacted_thinking", "[redacted]", { id: "", name: "", signature: block.data });
            else if (block.type === "text") { onStart(idx, "text", block.text); onStop(idx); }
            else if (block.type === "tool_use") { onStart(idx, "tool_use", JSON.stringify(block.input ?? {}), { id: block.id, name: block.name }); onStop(idx); }
          }
        }

        if (msg.type === "result") {
          const u = extractUsage(msg);
          if (u) Object.assign(partial, u);

          if (msg.subtype === "success") {
            partial.stopReason = "stop";
            stream.push({ type: "done", reason: "stop", message: { ...partial } });
          } else {
            partial.stopReason = "error";
            partial.errorMessage = msg.errors?.join("; ") ?? `CodeBuddy error: ${msg.subtype}`;
            stream.push({ type: "error", reason: "error", error: { ...partial } });
          }
          break;
        }
      }
    } catch (error) {
      stream.push({ type: "error", reason: "error", error: makeErrorPartial(model, error) });
    }
  });

  return stream;
}
