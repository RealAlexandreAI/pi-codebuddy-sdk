import * as piAi from "@earendil-works/pi-ai";
import type { Message, Tool } from "@earendil-works/pi-ai";

// Upstream #9548 ("Mid conversation system messages") folds `Context.systemPrompt` and
// `Context.tools` into the transcript's system messages, so provider-facing code receives a
// `TranscriptContext` that only carries `messages`. This module reads both shapes so the
// provider keeps working on pi-ai <= 0.85.1 and >= 0.85.2 without a hard version bump.

export interface TranscriptView {
	/** Conversation messages with system messages removed (the pre-#9548 shape). */
	messages: Message[];
	/** Rendered system prompt, or undefined when the request carries none. */
	systemPrompt: string | undefined;
	/** Tool declarations available for this request. */
	tools: Tool[] | undefined;
}

type MaybeTranscript = {
	messages: Message[];
	systemPrompt?: string;
	tools?: Tool[];
};

const ai = piAi as unknown as Record<string, unknown>;

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.join("");
	}
	return "";
}

/**
 * Read the system prompt, tool declarations, and conversation from a request context that
 * may be either a legacy `Context` or a normalized `TranscriptContext`.
 */
export function readTranscript(context: MaybeTranscript): TranscriptView {
	const messages = Array.isArray(context.messages) ? context.messages : [];

	// Legacy shape (pi-ai <= 0.85.1): prompt and tools are top-level fields.
	if (typeof context.systemPrompt === "string" || Array.isArray(context.tools)) {
		return { messages, systemPrompt: context.systemPrompt, tools: context.tools };
	}

	// Normalized shape (pi-ai >= 0.85.2): replay the transcript through upstream helpers.
	const collapseSystemMessages = ai.collapseSystemMessages as
		| ((c: { messages: Message[] }) => { messages: Message[] })
		| undefined;
	const getCurrentSystemPrompt = ai.getCurrentSystemPrompt as ((m: readonly unknown[]) => string) | undefined;
	const getCurrentTools = ai.getCurrentTools as ((m: readonly unknown[]) => Tool[]) | undefined;
	if (
		typeof collapseSystemMessages === "function" &&
		typeof getCurrentSystemPrompt === "function" &&
		typeof getCurrentTools === "function"
	) {
		const collapsed = collapseSystemMessages({ messages });
		return {
			messages: collapsed.messages.filter((message) => (message as { role?: string }).role !== "system"),
			systemPrompt: getCurrentSystemPrompt(collapsed.messages) || undefined,
			tools: getCurrentTools(collapsed.messages),
		};
	}

	// No upstream helpers available: best-effort replay of the leading system message.
	const systemMessages = messages.filter((message) => (message as { role?: string }).role === "system");
	const conversation = messages.filter((message) => (message as { role?: string }).role !== "system");
	const head = systemMessages[0] as (Message & { content?: unknown; toolsAdded?: Tool[] }) | undefined;
	if (!head) return { messages: conversation, systemPrompt: undefined, tools: undefined };
	return {
		messages: conversation,
		systemPrompt: textOfContent(head.content) || undefined,
		tools: head.toolsAdded,
	};
}
