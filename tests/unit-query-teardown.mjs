/**
 * Tests for deterministic CLI child-process teardown.
 *
 * Offline only: a fake transport for the close/no-op/idempotency cases, and one
 * real (but trivial) `node` child to prove the SIGKILL backstop actually reaps a
 * process that ignores SIGTERM. No CodeBuddy auth or pi subprocess required, so
 * these run in CI alongside the other unit-*.mjs suites.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeQueryTransport, endQuery } from "../src/query-teardown.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A fake `Query` carrying just the private `transport` field we reach for. */
function fakeQuery({ close, pid } = {}) {
	const q = { closed: 0 };
	q.transport = {
		process: pid === undefined ? undefined : { pid },
		close: typeof close === "function"
			? close
			: () => { q.closed += 1; },
	};
	return q;
}

describe("closeQueryTransport", () => {
	it("closes the transport on a never-iterated query (discoverModels regression)", () => {
		const q = fakeQuery();
		closeQueryTransport(q, "discoverModels");
		assert.equal(q.closed, 1, "transport.close() must run even when the query was never iterated");
	});

	it("is a no-op for missing / malformed queries and transports", () => {
		for (const bad of [undefined, null, {}, { transport: null }, { transport: {} }, { transport: { close: "nope" } }]) {
			assert.doesNotThrow(() => closeQueryTransport(bad, "x"), `should not throw for ${JSON.stringify(bad) ?? String(bad)}`);
		}
	});

	it("swallows a throwing close() and still logs the failure", () => {
		const logs = [];
		const q = fakeQuery({ close: () => { throw new Error("Transport not started"); } });
		assert.doesNotThrow(() => closeQueryTransport(q, "x", { log: (m) => logs.push(m) }));
		assert.ok(logs.some((l) => /transport close failed/.test(l)), `expected a failure log, got ${JSON.stringify(logs)}`);
	});

	it("does not schedule a force-kill when the transport reports no pid", async () => {
		const q = fakeQuery({ pid: undefined });
		closeQueryTransport(q, "x", { forceKillAfterMs: 20 });
		await sleep(60); // nothing to kill; the unref'd timer must be skipped entirely
		assert.equal(q.closed, 1);
	});

	it("leaves an already-gone child alone (no SIGKILL for a dead pid)", async () => {
		const logs = [];
		// A pid above macOS' pid_max (99999) can never exist.
		closeQueryTransport(fakeQuery({ pid: 999_999 }), "x", { forceKillAfterMs: 20, log: (m) => logs.push(m) });
		await sleep(80);
		assert.ok(!logs.some((l) => /SIGKILL/.test(l)), `must not SIGKILL a dead pid, got ${JSON.stringify(logs)}`);
	});

	it("force-kills a child that ignores SIGTERM (the backstop)", async () => {
		// A real child that swallows SIGTERM — exactly the failure mode a plain
		// transport.close()/terminate() cannot recover from.
		const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
		const pid = child.pid;
		child.on("error", () => {});
		try {
			assert.ok(pid, "child should have a pid");
			await sleep(120);
			assert.ok(alive(pid), "child should be alive and ignoring SIGTERM");

			closeQueryTransport(
				fakeQuery({
					pid,
					// Mimic the real transport: SIGTERM only. The child traps it.
					close: () => { try { process.kill(pid, "SIGTERM"); } catch {} },
				}),
				"backstop",
				{ forceKillAfterMs: 200 },
			);

			// Grace period + scheduling slack.
			for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
			assert.ok(!alive(pid), "the SIGKILL backstop must reap a child that ignored SIGTERM");
		} finally {
			try { process.kill(pid, "SIGKILL"); } catch {}
			child.unref?.();
		}
	});
});

describe("endQuery", () => {
	it("interrupts first, then closes the transport", () => {
		const order = [];
		const q = {
			interrupt: () => { order.push("interrupt"); return Promise.resolve(); },
			transport: { process: { pid: undefined }, close: () => { order.push("close"); } },
		};
		endQuery(q, "compact-summary");
		assert.deepEqual(order, ["interrupt", "close"]);
	});

	it("closes the transport even when interrupt() rejects or throws", async () => {
		let closed = 0;
		const rejecting = { interrupt: () => Promise.reject(new Error("gone")), transport: { close: () => { closed += 1; } } };
		const throwing = { interrupt: () => { throw new Error("boom"); }, transport: { close: () => { closed += 1; } } };
		assert.doesNotThrow(() => endQuery(rejecting, "x"));
		assert.doesNotThrow(() => endQuery(throwing, "x"));
		await sleep(0); // let the rejected interrupt() promise settle
		assert.equal(closed, 2, "teardown must run regardless of interrupt() outcome");
	});
});
