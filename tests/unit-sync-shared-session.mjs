/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const debugDir = mkdtempSync(join(tmpdir(), "sync-shared-session-debug-"));
process.env.CODEBUDDY_SDK_DEBUG_PATH = join(debugDir, "codebuddy-sdk.log");

const { __test } = await import("../src/index.js");

describe("syncSharedSession", () => {
	after(() => {
		rmSync(debugDir, { recursive: true, force: true });
	});

	afterEach(() => {
		__test.resetSharedSession();
	});

	it("does not reuse a cached main session for a shorter synthetic compact context", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const mainSession = {
				sessionId: "11111111-1111-4111-8111-111111111111",
				cursor: 42,
				cwd,
			};
			__test.setSharedSession(mainSession);

			const result = __test.syncSharedSession([
				{
					role: "user",
					content: "Summarize this conversation.",
					timestamp: Date.now(),
				},
			], cwd);

			assert.equal(
				result.sessionId,
				null,
				"synthetic compact contexts have no prior messages and must start a fresh CodeBuddy session instead of resuming the main session",
			);
			assert.equal(
				result.preserveSharedSession,
				true,
				"the fresh synthetic CodeBuddy session must not replace the cached main session when it completes",
			);
			assert.deepEqual(__test.getSharedSession(), mainSession);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// Issue #10: after an interrupted turn, pi rewrites history shorter than the
	// provider's cursor. The old code fell back to a context-free clean start,
	// so the model answered as if the conversation never happened. A top-level
	// call with real history left must rebuild instead.
	it("rebuilds instead of clean-starting when pi's history shrinks but keeps context (issue #10)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-shrink-"));
		const previousConfigDir = process.env.CODEBUDDY_CONFIG_DIR;
		process.env.CODEBUDDY_CONFIG_DIR = cwd;
		try {
			const mainSession = {
				sessionId: "22222222-2222-4222-8222-222222222222",
				cursor: 42,
				cwd,
			};
			__test.setSharedSession(mainSession);

			const prior = Array.from({ length: 10 }, (_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `message ${i}`,
				timestamp: Date.now(),
			}));

			const result = __test.syncSharedSession(
				[...prior, { role: "user", content: "retry after interrupt", timestamp: Date.now() }],
				cwd,
				undefined,
				undefined,
				false,
			);

			assert.equal(
				result.preserveSharedSession,
				undefined,
				"a shrunk-but-non-empty history must not fall back to a context-free clean start",
			);
			assert.ok(
				result.sessionId,
				"a shrunk-but-non-empty history must produce a session to resume",
			);
			assert.equal(
				__test.getSharedSession()?.cursor,
				prior.length,
				"the rebuilt session cursor must match the truncated history",
			);
		} finally {
			if (previousConfigDir === undefined) delete process.env.CODEBUDDY_CONFIG_DIR;
			else process.env.CODEBUDDY_CONFIG_DIR = previousConfigDir;
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// Reentrant subagent calls must never rewrite the parent's shared session.
	it("keeps the clean start for a reentrant call with a shorter context", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-reentrant-"));
		try {
			const mainSession = {
				sessionId: "33333333-3333-4333-8333-333333333333",
				cursor: 42,
				cwd,
			};
			__test.setSharedSession(mainSession);

			const result = __test.syncSharedSession(
				[
					{ role: "user", content: "first", timestamp: Date.now() },
					{ role: "assistant", content: "reply", timestamp: Date.now() },
					{ role: "user", content: "subagent prompt", timestamp: Date.now() },
				],
				cwd,
				undefined,
				undefined,
				true,
			);

			assert.equal(result.sessionId, null);
			assert.equal(result.preserveSharedSession, true);
			assert.deepEqual(__test.getSharedSession(), mainSession);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
