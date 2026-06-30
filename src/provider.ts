/**
 * CodeBuddy Provider — stateless, lightweight.
 *
 * Uses sdk.query() (one-shot) — no context building, no session pool,
 * no tool boundary. Pi manages conversation, CodeBuddy is just a model backend.
 *
 * Architecture follows pi-openai-compatible / pi-anthropic pattern:
 * extract latest user message → send to SDK → stream events back to Pi.
 */
import {
  createAssistantMessageEventStream,
  type Api,
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
  Message as CbMessage,
  ThinkingConfig,
  Effort,
  RawMessageStreamEvent,
} from "@tencent-ai/agent-sdk";

type CodebuddySdk = typeof import("@tencent-ai/agent-sdk");

async function loadCodebuddySdk(): Promise<CodebuddySdk> {
  return import("@tencent-ai/agent-sdk");
}

// ── helpers ──

function makePartial(model: Model<Api>): AssistantMessage {
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

function makeErrorPartial(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    ...makePartial(model),
    stopReason: "error",
    errorMessage: `CodeBuddy SDK error: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function extractUsageUpdate(msg: CbMessage): Partial<AssistantMessage> | null {
  if (msg.type === "result" && msg.usage) {
    return {
      usage: {
        input: msg.usage.input_tokens ?? 0,
        output: msg.usage.output_tokens ?? 0,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
        totalTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: msg.total_cost_usd ?? 0,
        },
      },
    };
  }
  return null;
}

// ── extract latest user message ──

function extractLatestUserText(context: Context): string {
  const messages = context.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      let raw = extractRawContent((messages[i] as any).content);
      if (!raw) continue;
      // Strip context-mode session state injection prepended to user messages.
      // Pi's context-mode adds its hierarchy/state before the actual user input.
      raw = stripContextModeInjection(raw);
      if (raw) return raw;
    }
  }
  return "Continue.";
}

function extractRawContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

/**
 * Pi context-mode prepends its session state to user messages.
 * Strip it to keep CodeBuddy from treating it as conversation content.
 *
 * Injected format:
 *   context-mode active. Hierarchy: ...
 *   <session_state source="compaction">
 *   <session_mode>investigate</session_mode>
 *   </session_state>
 *   [actual user message]
 */
function stripContextModeInjection(text: string): string {
  // Find the end of context-mode injection
  // Pattern: </session_state> followed by newlines then actual message
  const sessionEnd = text.lastIndexOf("</session_state>");
  if (sessionEnd >= 0) {
    const after = text.slice(sessionEnd + "</session_state>".length).trimStart();
    if (after) return after;
  }

  // Fallback: look for "context-mode active" header and take everything after it + session_state
  const cmStart = text.indexOf("context-mode active.");
  if (cmStart >= 0) {
    // Find first blank line after </session_state> or end of XML
    const afterSession = afterSessionState(text);
    if (afterSession) return afterSession;
  }

  return text;
}

function afterSessionState(text: string): string | null {
  // Try to find the actual user message after context-mode XML injection
  const patterns = [
    /context-mode active\.[\s\S]*?<\/session_state>\s*\n+([\s\S]+)$/,
    /<session_state[\s\S]*?<\/session_state>\s*\n+([\s\S]+)$/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

// ── thinking config mapping ──

const DEFAULT_THINKING_BUDGETS: Record<string, number> = {
  minimal: 1600,
  low: 4000,
  medium: 0,
  high: 0,
  xhigh: 32000,
};

const DEFAULT_EFFORT: Record<string, Effort | undefined> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

function buildThinkingConfig(
  reasoning: string | undefined,
  thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"],
): { thinking?: ThinkingConfig; effort?: Effort } {
  if (!reasoning) return {};
  if (reasoning === "off") return { thinking: { type: "disabled" } };

  const budget = thinkingBudgets?.[reasoning as keyof typeof thinkingBudgets]
    ?? DEFAULT_THINKING_BUDGETS[reasoning] ?? 0;
  const effort = DEFAULT_EFFORT[reasoning];

  if (budget > 0) return { thinking: { type: "enabled", budgetTokens: budget }, effort };
  return { thinking: { type: "adaptive" }, effort };
}

// ── main provider ──

export function streamCodebuddy(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial = makePartial(model);

  queueMicrotask(async () => {
    try {
      stream.push({ type: "start", partial });

      const sdk = await loadCodebuddySdk();
      const userText = extractLatestUserText(context);

      const { thinking, effort } = buildThinkingConfig(
        options?.reasoning,
        options?.thinkingBudgets,
      );

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

      // ── abort handling ──
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
        if (options.signal.aborted) {
          await onAbort();
          return;
        }
      }

      // ── per-index block tracking ──
      type BlockKind = 'text' | 'thinking' | 'tool_use' | 'redacted_thinking';
      const blockKind = new Map<number, BlockKind>();
      const blockAccum = new Map<number, string>();
      const blockMeta = new Map<number, { id: string; name: string; signature?: string }>();

      let hasStreamEvents = false;

      function onBlockStart(idx: number, kind: BlockKind, initText: string, meta?: { id: string; name: string; signature?: string }) {
        blockKind.set(idx, kind);
        blockAccum.set(idx, initText);
        if (meta) blockMeta.set(idx, meta);

        if (kind === 'redacted_thinking') {
          const tc: ThinkingContent = { type: 'thinking', thinking: '[redacted]', redacted: true, thinkingSignature: meta?.signature };
          partial.content = [...partial.content, tc];
          stream.push({ type: 'thinking_start', contentIndex: idx, partial });
          stream.push({ type: 'thinking_end', contentIndex: idx, content: '[redacted]', partial });
        } else if (kind === 'thinking') {
          const tc: ThinkingContent = { type: 'thinking', thinking: initText, thinkingSignature: meta?.signature };
          partial.content = [...partial.content, tc];
          stream.push({ type: 'thinking_start', contentIndex: idx, partial });
        } else if (kind === 'text') {
          const tb: TextContent = { type: 'text', text: initText };
          partial.content = [...partial.content, tb];
          stream.push({ type: 'text_start', contentIndex: idx, partial });
        } else if (kind === 'tool_use' && meta) {
          const toolCall: ToolCall = { type: 'toolCall', id: meta.id, name: meta.name, arguments: {} };
          partial.content = [...partial.content, toolCall];
          stream.push({ type: 'toolcall_start', contentIndex: idx, partial });
        }
      }

      function onBlockDelta(idx: number, deltaType: string, deltaValue: string) {
        const kind = blockKind.get(idx);
        if (!kind) return;

        if (deltaType === 'text_delta' && kind === 'text') {
          const newText = (blockAccum.get(idx) || '') + deltaValue;
          blockAccum.set(idx, newText);
          const blocks = [...partial.content];
          blocks[idx] = { type: 'text', text: newText };
          partial.content = blocks;
          stream.push({ type: 'text_delta', contentIndex: idx, delta: deltaValue, partial });
        } else if (deltaType === 'thinking_delta' && kind === 'thinking') {
          const newThinking = (blockAccum.get(idx) || '') + deltaValue;
          blockAccum.set(idx, newThinking);
          const blocks = [...partial.content];
          blocks[idx] = { type: 'thinking', thinking: newThinking, thinkingSignature: blockMeta.get(idx)?.signature };
          partial.content = blocks;
          stream.push({ type: 'thinking_delta', contentIndex: idx, delta: deltaValue, partial });
        } else if (deltaType === 'input_json_delta' && kind === 'tool_use') {
          const newJson = (blockAccum.get(idx) || '') + deltaValue;
          blockAccum.set(idx, newJson);
          const blocks = [...partial.content];
          try {
            blocks[idx] = { ...blocks[idx], arguments: JSON.parse(newJson) };
          } catch { /* partial JSON */ }
          partial.content = blocks;
          stream.push({ type: 'toolcall_delta', contentIndex: idx, delta: deltaValue, partial } as any);
        }
      }

      function onBlockStop(idx: number) {
        const kind = blockKind.get(idx);
        const accum = blockAccum.get(idx) || '';
        if (kind === 'text') {
          stream.push({ type: 'text_end', contentIndex: idx, content: accum, partial });
        } else if (kind === 'thinking') {
          stream.push({ type: 'thinking_end', contentIndex: idx, content: accum, partial });
        } else if (kind === 'tool_use') {
          const toolCall = partial.content[idx] as ToolCall;
          stream.push({ type: 'toolcall_end', contentIndex: idx, toolCall, partial });
        }
      }

      // ── iterate ──
      for await (const msg of q) {
        if (aborted) return;

        if (msg.type === "system") {
          if (msg.model) partial.responseModel = msg.model;
          continue;
        }

        if (msg.type === "stream_event") {
          hasStreamEvents = true;
          const evt = msg.event;

          if (evt.type === "content_block_start") {
            const block = evt.content_block;
            if (block.type === "text") {
              onBlockStart(evt.index, 'text', block.text || '');
            } else if (block.type === "thinking") {
              onBlockStart(evt.index, 'thinking', block.thinking || '', { id: '', name: '', signature: block.signature });
            } else if (block.type === "redacted_thinking") {
              onBlockStart(evt.index, 'redacted_thinking', '[redacted]', { id: '', name: '', signature: block.data });
            } else if (block.type === "tool_use") {
              const initJson = JSON.stringify(block.input || {});
              onBlockStart(evt.index, 'tool_use', initJson, { id: block.id, name: block.name });
            }
          } else if (evt.type === "content_block_delta") {
            const d = evt.delta;
            if (d.type === 'text_delta') onBlockDelta(evt.index, 'text_delta', d.text);
            else if (d.type === 'thinking_delta') onBlockDelta(evt.index, 'thinking_delta', d.thinking);
            else if (d.type === 'input_json_delta') onBlockDelta(evt.index, 'input_json_delta', d.partial_json);
          } else if (evt.type === "content_block_stop") {
            onBlockStop(evt.index);
          }
          continue;
        }

        // Fallback: full assistant messages
        if (msg.type === "assistant" && !hasStreamEvents) {
          let ci = 0;
          for (const block of msg.message.content) {
            const idx = ci++;
            if (block.type === "thinking") {
              onBlockStart(idx, 'thinking', block.thinking);
              onBlockStop(idx);
            } else if (block.type === "redacted_thinking") {
              onBlockStart(idx, 'redacted_thinking', '[redacted]', { id: '', name: '', signature: block.data });
            } else if (block.type === "text") {
              onBlockStart(idx, 'text', block.text);
              onBlockStop(idx);
            } else if (block.type === "tool_use") {
              const initJson = JSON.stringify(block.input ?? {});
              onBlockStart(idx, 'tool_use', initJson, { id: block.id, name: block.name });
              onBlockStop(idx);
            }
          }
        }

        if (msg.type === "result") {
          const usageUpdate = extractUsageUpdate(msg);
          if (usageUpdate) Object.assign(partial, usageUpdate);

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
      const errPartial = makeErrorPartial(model, error);
      stream.push({ type: "error", reason: "error", error: errPartial });
    }
  });

  return stream;
}
