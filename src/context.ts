import type { Context, ImageContent } from "@earendil-works/pi-ai/compat";
import type { UserMessage as CbUserMessage, ContentBlock } from "@tencent-ai/agent-sdk";

/**
 * Build a CodeBuddy UserMessage from the FULL Pi Context.
 * Used on the first turn of a pooled session.
 *
 * Returns either a plain string (text-only) or a structured UserMessage
 * with ContentBlock[] when images are present in the latest user message.
 */
export function buildFullMessage(context: Context): string | CbUserMessage {
  return buildMessage(context, 0);
}

/**
 * Build a CodeBuddy UserMessage from only NEW messages since startIndex.
 * Used on continuation turns of a pooled session (delta mode).
 *
 * Historical messages before startIndex are omitted — the CodeBuddy
 * session already has them in its internal context.
 */
export function buildDeltaMessage(context: Context, startIndex: number): string | CbUserMessage {
  return buildMessage(context, startIndex);
}

// ── internal ──

function buildMessage(context: Context, startIndex: number): string | CbUserMessage {
  const prefix = buildHistoryPrefix(context, startIndex);
  const lastUserMsg = findLastUserMessage(context, startIndex);
  const images = extractImages(lastUserMsg);

  if (images.length === 0) {
    return prefix + extractTextFromMessage(lastUserMsg);
  }

  // Image support: build ContentBlock[]
  const blocks: ContentBlock[] = [];

  if (prefix) {
    blocks.push({ type: "text", text: prefix });
  }

  for (const block of lastUserMsg!.content) {
    if (typeof block === "string") {
      blocks.push({ type: "text", text: block });
    } else if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: parseImageMediaType(block.mimeType),
          data: stripBase64Prefix(block.data),
        },
      });
    }
  }

  return {
    type: "user",
    session_id: "",
    message: { role: "user", content: blocks },
    parent_tool_use_id: null,
  };
}

/**
 * Build conversation history prefix for messages in [startIndex, end).
 * The latest user message is always excluded (handled separately).
 */
function buildHistoryPrefix(context: Context, startIndex: number): string {
  const parts: string[] = [];

  // ponytail: skip Pi systemPrompt — CodeBuddy uses its own.
  // Pi's prompt references MCP/tool ecosystem not present in CodeBuddy,
  // which confuses the model into calling non-existent tools.

  const messages = context.messages;

  // All messages in range except the last user message
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (i === messages.length - 1 && msg.role === "user") continue;

    if (msg.role === "user") {
      const text = extractTextContent(msg.content);
      const hasImages = extractImages(msg).length > 0;
      if (text) {
        parts.push(`User: ${text}${hasImages ? " [image omitted]" : ""}`);
      } else if (hasImages) {
        parts.push("User: [image omitted]");
      }
    } else if (msg.role === "assistant") {
      const text = extractTextContent(msg.content);
      if (text) parts.push(`Assistant: ${text}`);
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          parts.push(
            `[Tool used: ${block.name}(${JSON.stringify(block.arguments)})]`,
          );
        }
      }
    } else if (msg.role === "toolResult") {
      const text = extractTextContent(msg.content);
      const status = msg.isError ? "Error" : "Result";
      const snippet = truncateToolResult(text);
      parts.push(`[Tool ${status} (${msg.toolName}): ${snippet}]`);
    }
  }

  return parts.length > 0 ? parts.join("\n") + "\n\n" : "";
}

/**
 * Truncate tool result with head + tail strategy (industry best practice).
 * Head 1200 chars (captures output start), tail 600 chars (captures errors/summaries),
 * marker in middle.
 */
const TOOL_RESULT_HEAD = 1200;
const TOOL_RESULT_TAIL = 600;

function truncateToolResult(text: string): string {
  if (!text) return "(empty)";
  if (text.length <= TOOL_RESULT_HEAD + TOOL_RESULT_TAIL + 50) return text;

  const head = text.slice(0, TOOL_RESULT_HEAD);
  const tail = text.slice(-TOOL_RESULT_TAIL);
  const skipped = text.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  return `${head}\n...[${skipped.toLocaleString()} chars skipped]...\n${tail}`;
}

// ── helpers ──

function findLastUserMessage(context: Context, startIndex: number) {
  for (let i = context.messages.length - 1; i >= startIndex; i--) {
    if (context.messages[i].role === "user") return context.messages[i];
  }
  return null;
}

function extractImages(msg: any): ImageContent[] {
  if (!msg || !Array.isArray(msg.content)) return [];
  return msg.content.filter(
    (c: any) => typeof c === "object" && c !== null && c.type === "image",
  );
}

function extractTextFromMessage(msg: any): string {
  if (!msg) return "Continue.";
  return extractTextContent(msg.content) || "Continue.";
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" &&
        c !== null &&
        "type" in c &&
        c.type === "text" &&
        "text" in c,
    )
    .map((c) => c.text)
    .join("\n");
}

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function parseImageMediaType(mimeType: string): ImageMediaType {
  const valid: ImageMediaType[] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ];
  if (valid.includes(mimeType as ImageMediaType))
    return mimeType as ImageMediaType;
  return "image/png";
}

function stripBase64Prefix(data: string): string {
  const comma = data.indexOf(",");
  return comma >= 0 ? data.slice(comma + 1) : data;
}
