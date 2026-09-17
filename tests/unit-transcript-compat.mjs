/**
 * Regression tests for readTranscript(): the provider must read both the legacy
 * Context (top-level systemPrompt/tools) and the post-#9548 normalized transcript
 * (prompt and tools carried by system messages).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { readTranscript } = await import("../src/transcript-compat.js");

const tool = { name: "read", description: "read a file", parameters: { type: "object" } };

describe("readTranscript", () => {
	it("passes through the legacy context shape unchanged", () => {
		const context = {
			systemPrompt: "base prompt",
			tools: [tool],
			messages: [{ role: "user", content: "hi" }],
		};
		const view = readTranscript(context);
		assert.equal(view.systemPrompt, "base prompt");
		assert.deepEqual(view.tools, [tool]);
		assert.deepEqual(view.messages, [{ role: "user", content: "hi" }]);
	});

	it("reads the prompt and tools from a leading system message", () => {
		const context = {
			messages: [
				{ role: "system", content: "folded prompt", toolsAdded: [tool] },
				{ role: "user", content: "hi" },
			],
		};
		const view = readTranscript(context);
		assert.equal(view.systemPrompt, "folded prompt");
		assert.deepEqual(view.tools, [tool]);
		assert.deepEqual(view.messages, [{ role: "user", content: "hi" }]);
	});

	it("drops mid-conversation system messages from the forwarded conversation", () => {
		const context = {
			messages: [
				{ role: "system", content: "folded prompt" },
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				{ role: "system", content: "later instruction" },
			],
		};
		const view = readTranscript(context);
		assert.deepEqual(
			view.messages.map((m) => m.role),
			["user", "assistant"],
		);
	});

	it("returns undefined prompt/tools for a transcript without system messages", () => {
		const context = { messages: [{ role: "user", content: "hi" }] };
		const view = readTranscript(context);
		assert.equal(view.systemPrompt, undefined);
		assert.equal(view.tools, undefined);
		assert.deepEqual(view.messages, [{ role: "user", content: "hi" }]);
	});
});
