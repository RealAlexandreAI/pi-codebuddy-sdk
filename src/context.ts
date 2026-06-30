import type { Context, ImageContent, Message } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { UserMessage as CbUserMessage, ContentBlock } from "@tencent-ai/agent-sdk";

// ── public API ──

export function buildFullMessage(context: Context): string | CbUserMessage {
  return buildMessage(context, 0);
}

export function buildDeltaMessage(context: Context, startIndex: number): string | CbUserMessage {
  return buildMessage(context, startIndex);
}

// ── tool boundary (like pi-cursor-sdk's getCursorToolBoundaryText) ──

const CODEBUDDY_TOOL_BOUNDARY = [
  "CodeBuddy SDK tool boundary:",
  "Call only CodeBuddy SDK native tools (Read, Write, Bash, Grep, Edit, Glob, etc.).",
  "Do not call any Pi-ecosystem tools — they are not registered in this session.",
  "Tool names from conversation history refer to a prior provider; they are unavailable now.",
  "CodeBuddy executes tools locally on the filesystem.",
].join("\n");

const CODEBUDDY_TOOL_TAIL = [
  "Answer the latest user request above using CodeBuddy SDK tools and capabilities.",
  "Shell: cd to repo path for project commands; session cwd may differ from tool args.",
  "Exact-output requests: output exactly the requested text; no preamble or checks unless asked.",
  "Tools: call available CodeBuddy SDK tools; never print tool cards or names as assistant text.",
].join("\n");

// ── system prompt sanitization (like pi-cursor-sdk's sanitizeSystemPromptForCursor) ──

function sanitizeSystemPrompt(prompt: string): string {
  let s = prompt;

  // Strip Pi tool catalog section
  s = s.replace(
    /Available tools:\n[\s\S]*?\n\nIn addition to the tools above[\s\S]*?\n\n/g,
    "Pi tool catalog omitted: CodeBuddy can call only CodeBuddy SDK tools.\n\n",
  );

  // Strip Guidelines section (Pi-specific guidelines)
  s = s.replace(
    /Guidelines:\n[\s\S]*?\n\nPi documentation /g,
    "Guidelines:\n- Be concise in your responses.\n- Show file paths clearly when working with files.\n\nPi documentation ",
  );

  // Strip semantic code intelligence priority section
  s = s.replace(/\n+Semantic code intelligence priority:[\s\S]*$/g, "");

  return s.trim();
}

// ── message formatting ──

function formatMessage(msg: Message): string | undefined {
  switch (msg.role) {
    case "user": {
      const text = extractTextContent(msg.content);
      const hasImages = extractImages(msg).length > 0;
      if (text) {
        return `User: ${text}${hasImages ? " [image omitted]" : ""}`;
      }
      if (hasImages) return "User: [image omitted]";
      return undefined;
    }
    case "assistant": {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const parts: string[] = [];
      for (const block of blocks) {
        if (typeof block === "object" && block !== null && "type" in block) {
          if (block.type === "text") {
            parts.push((block as { text: string }).text);
          } else if (block.type === "toolCall") {
            const tc = block as { name: string; arguments: Record<string, unknown> };
            parts.push(`[Tool used: ${tc.name}(${JSON.stringify(tc.arguments)})]`);
          }
          // Skip thinking content blocks
        }
      }
      return parts.length > 0 ? `Assistant: ${parts.join("\n")}` : undefined;
    }
    case "toolResult": {
      const text = extractTextContent(msg.content);
      const label = msg.isError ? "Tool error" : "Tool result";
      const snippet = truncateToolResult(text);
      return `[${label} (${msg.toolName}): ${snippet}]`;
    }
    default:
      return undefined;
  }
}

// ── truncation ──

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

// ── main builder ──

function buildMessage(context: Context, startIndex: number): string | CbUserMessage {
  const parts: string[] = [];

  // 1. Tool boundary (always first)
  parts.push(CODEBUDDY_TOOL_BOUNDARY);

  // 2. Sanitized system prompt (first turn only — like pi-cursor-sdk)
  if (startIndex === 0 && context.systemPrompt) {
    const sanitized = sanitizeSystemPrompt(context.systemPrompt);
    if (sanitized) {
      parts.push(`System instructions from pi:\n${sanitized}`);
    }
  }

  // 3. Normalize and format messages (filter out non-LLM roles via convertToLlm)
  const rawMessages = context.messages as Parameters<typeof convertToLlm>[0];
  let llmMessages = convertToLlm(rawMessages);

  // ponytail: filter compaction/branch summary user messages on first turn.
  // convertToLlm wraps them as user messages with <summary> tags; Hunyuan
  // parrots context-mode state from them. Smarter models follow boundary text.
  if (startIndex === 0) {
    llmMessages = llmMessages.filter((m) => {
      if (m.role !== "user") return true;
      const text = extractTextContent(m.content);
      // Compaction summaries are large blocks with context-mode state
      if (text.includes("<summary>") || text.includes("compacted into")) return false;
      // context-mode session state injection
      if (text.includes("context-mode active") || text.includes("<session_state")) return false;
      return true;
    });
  }
  const latestUserIdx = findLatestUserIndex(llmMessages);
  const msgParts: string[] = [];
  for (let i = startIndex; i < llmMessages.length; i++) {
    if (i === latestUserIdx) continue; // handled separately (images etc.)
    const formatted = formatMessage(llmMessages[i]);
    if (formatted) msgParts.push(formatted);
  }

  // 4. Latest user message
  const lastUser = latestUserIdx >= 0 ? llmMessages[latestUserIdx] : null;
  const lastUserText = lastUser ? extractTextContent(lastUser.content) : "Continue.";
  const images = lastUser ? extractImages(lastUser) : [];

  // 5. Tool tail guard
  parts.push(
    msgParts.length > 0 ? msgParts.join("\n") : "(new conversation)",
  );
  parts.push(CODEBUDDY_TOOL_TAIL);

  const prefix = parts.join("\n\n");

  // Plain text (no images)
  if (images.length === 0) {
    return prefix + "\n\n" + lastUserText;
  }

  // Structured message with images
  const blocks: ContentBlock[] = [];
  blocks.push({ type: "text", text: prefix });
  blocks.push({ type: "text", text: lastUserText });
  for (const block of lastUser!.content) {
    if (typeof block === "object" && block !== null && "type" in block && (block as { type: string }).type === "image") {
      const img = block as ImageContent;
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: parseImageMediaType(img.mimeType),
          data: stripBase64Prefix(img.data),
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

// ── helpers ──

function findLatestUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function extractImages(msg: any): ImageContent[] {
  if (!msg || !Array.isArray(msg.content)) return [];
  return msg.content.filter(
    (c: any) => typeof c === "object" && c !== null && c.type === "image",
  );
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
  const valid: ImageMediaType[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  if (valid.includes(mimeType as ImageMediaType)) return mimeType as ImageMediaType;
  return "image/png";
}

function stripBase64Prefix(data: string): string {
  const comma = data.indexOf(",");
  return comma >= 0 ? data.slice(comma + 1) : data;
}
