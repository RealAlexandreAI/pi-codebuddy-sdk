// Guarantee the CodeBuddy CLI subprocess is reaped once a query is finished.
//
// The @tencent-ai/agent-sdk `Query` closes its transport (which ends stdin and
// terminates the spawned `codebuddy-headless.js` child) only from its private
// `cleanup()`, and `cleanup()` runs only in `createIterator()`'s `finally` —
// i.e. only if the query was actually iterated to completion. `Query.return()`
// just sends an `interrupt` control frame and, per its own comment, "does not
// close the transport".
//
// Any path that never iterates the query therefore leaks the child for the
// lifetime of the host process. `discoverModels()` is the clearest offender: it
// issues a single `supportedModels()` control request and abandons the query,
// so its iterator (and `cleanup()`) never runs. Long-running sessions pile up
// stopped CLIs and eventually exhaust the CLI's local port pool (EADDRINUSE on
// 127.0.0.1:6252x/6253x).
//
// We reach for the transport the same way the issue #10 teardown guard in
// index.ts already does: `Transport.close()` is public (transport/index.d.ts),
// but `Query.transport` and `Query.cleanup()` are private (query.d.ts).
// `close()` is idempotent (`if (this.closed) return;`), so calling it after a
// query that already completed on its own is a harmless no-op.

type ClosableTransport = { close?: () => void; process?: { pid?: number } };
type TeardownQuery = { transport?: ClosableTransport | null };

export type TeardownOptions = {
	/** Force-kill the child if it is still alive this long after close(). */
	forceKillAfterMs?: number;
	/** Optional debug sink (wired to index.ts `debug()` at the call sites). */
	log?: (msg: string) => void;
};

const DEFAULT_FORCE_KILL_MS = 2000;

/**
 * Close the query's transport and, as a backstop for a CLI that ignores
 * SIGTERM, force-kill its child process if it is still alive shortly after.
 * A no-op for anything that does not look like a closable query.
 */
export function closeQueryTransport(q: unknown, label: string, options: TeardownOptions = {}): void {
	const transport = (q as TeardownQuery | null | undefined)?.transport;
	if (!transport || typeof transport.close !== "function") return;

	// Capture the pid before close() nulls out `transport.process`.
	const pid = typeof transport.process?.pid === "number" ? transport.process.pid : undefined;

	try {
		transport.close();
		options.log?.(`teardown(${label}): transport closed${pid !== undefined ? ` (pid ${pid})` : ""}`);
	} catch (err) {
		options.log?.(`teardown(${label}): transport close failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (pid === undefined) return;

	// Backstop: if the CLI did not exit on the transport's own terminate(),
	// force-kill it so we never leak a stopped child.
	const wait = options.forceKillAfterMs ?? DEFAULT_FORCE_KILL_MS;
	const timer = setTimeout(() => {
		try {
			process.kill(pid, 0); // throws ESRCH once the child is gone
		} catch {
			return;
		}
		try {
			process.kill(pid, "SIGKILL");
			options.log?.(`teardown(${label}): CLI pid ${pid} survived transport close, sent SIGKILL`);
		} catch {
			// Raced with its own exit — nothing to do.
		}
	}, wait);
	// Never let this safety net hold the process/event loop open.
	timer.unref?.();
}

/** Stop the in-flight turn, then guarantee the CLI child process exits. */
export function endQuery(q: unknown, label: string, options: TeardownOptions = {}): void {
	try {
		void (q as { interrupt?: () => Promise<unknown> } | null | undefined)?.interrupt?.()?.catch?.(() => {});
	} catch {
		// interrupt() failing on a half-dead query is expected; teardown still runs.
	}
	closeQueryTransport(q, label, options);
}
