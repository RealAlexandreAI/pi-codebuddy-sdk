// CodeBuddy session JSONL read/write for pi session sync (replaces cc-session-io).
// CodeBuddy stores sessions at ~/.codebuddy/projects/<sanitized-path>/<sessionId>.jsonl

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { convertPiMessages, messageContentToText } from "./convert.js";

export interface CbMessage {
	role: "user" | "assistant";
	content: string;
}

export function getCodebuddyDir(codebuddyDir?: string): string {
	return codebuddyDir ?? process.env.CODEBUDDY_CONFIG_DIR ?? join(homedir(), ".codebuddy");
}

export function normalizeProjectPath(projectPath: string): string {
	return projectPath.replace(/\/+$/, "") || projectPath;
}

export function projectPathToHash(projectPath: string): string {
	// Keep session paths aligned with CodeBuddy CLI PathUtils.compressPath.
	return normalizeProjectPath(projectPath)
		.replace(/[/\\:]/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "")
		.replace(/-+/g, "-");
}

export function getProjectDir(projectPath: string, codebuddyDir?: string): string {
	return join(getCodebuddyDir(codebuddyDir), "projects", projectPathToHash(projectPath));
}

export function getSessionPath(sessionId: string, projectPath: string, codebuddyDir?: string): string {
	return join(getProjectDir(projectPath, codebuddyDir), `${sessionId}.jsonl`);
}

export function deleteSession(sessionId: string, projectPath: string, codebuddyDir?: string): void {
	const jsonlPath = getSessionPath(sessionId, projectPath, codebuddyDir);
	const dir = join(getProjectDir(projectPath, codebuddyDir), sessionId);
	try { rmSync(jsonlPath, { force: true }); } catch { /* ignore */ }
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function piToCbMessages(messages: PiMessage[]): CbMessage[] {
	const { anthropicMessages } = convertPiMessages(messages);
	const out: CbMessage[] = [];
	for (const msg of anthropicMessages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string"
				? msg.content
				: msg.content.map((b: any) => b.type === "text" ? b.text : b.type === "tool_result" ? `[tool_result:${b.tool_use_id}]` : `[${b.type}]`).join("\n");
			out.push({ role: "user", content: text });
		} else if (msg.role === "assistant") {
			const text = typeof msg.content === "string"
				? msg.content
				: msg.content.map((b: any) => b.type === "text" ? b.text : b.type === "tool_use" ? `[tool:${b.name}]` : `[${b.type}]`).join("\n");
			out.push({ role: "assistant", content: text });
		}
	}
	return out;
}

function writeCbJsonl(sessionId: string, cwd: string, messages: CbMessage[]): string {
	const jsonlPath = getSessionPath(sessionId, cwd);
	mkdirSync(join(jsonlPath, ".."), { recursive: true });
	const lines: string[] = [];
	let parentId: string | undefined;
	const ts = Date.now();
	for (const msg of messages) {
		const id = randomUUID();
		if (msg.role === "user") {
			lines.push(JSON.stringify({
				id, timestamp: ts, type: "message", role: "user",
				content: [{ type: "input_text", text: msg.content }],
				providerData: { agent: "sdk" }, sessionId, cwd,
			}));
			parentId = id;
		} else {
			lines.push(JSON.stringify({
				id, parentId, timestamp: ts, type: "message", role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: msg.content }],
				providerData: { agent: "sdk" }, sessionId, cwd,
			}));
			parentId = id;
		}
	}
	writeFileSync(jsonlPath, lines.join("\n") + (lines.length ? "\n" : ""));
	return jsonlPath;
}

export class Session {
	readonly sessionId: string;
	readonly projectPath: string;
	readonly codebuddyDir?: string;
	readonly jsonlPath: string;
	messages: CbMessage[] = [];

	constructor(sessionId: string, projectPath: string, codebuddyDir?: string) {
		this.sessionId = sessionId;
		this.projectPath = projectPath;
		this.codebuddyDir = codebuddyDir;
		this.jsonlPath = getSessionPath(sessionId, projectPath, codebuddyDir);
	}

	importPiMessages(messages: PiMessage[]): void {
		this.messages = piToCbMessages(messages);
	}

	save(): void {
		writeCbJsonl(this.sessionId, this.projectPath, this.messages);
	}
}

export interface CreateSessionOptions {
	projectPath: string;
	sessionId?: string;
	model?: string;
	codebuddyDir?: string;
}

export function createSession(opts: CreateSessionOptions): Session {
	const sessionId = opts.sessionId ?? randomUUID();
	return new Session(sessionId, opts.projectPath, opts.codebuddyDir);
}

export function repairToolPairing(messages: Array<{ role: string; content: unknown }>): Array<{ role: string; content: unknown }> {
	const result: Array<{ role: string; content: unknown }> = [];
	let pending: Set<string> | null = null;
	const synthetic = (id: string) => ({
		type: "tool_result",
		tool_use_id: id,
		content: "[no tool result recorded]",
		is_error: true,
	});
	const flushPending = () => {
		if (pending && pending.size > 0) {
			result.push({ role: "user", content: [...pending].map(synthetic) });
		}
		pending = null;
	};
	for (const msg of messages) {
		if (msg.role === "assistant") {
			flushPending();
			const ids = new Set<string>();
			if (Array.isArray(msg.content)) {
				for (const b of msg.content as Array<{ type?: string; id?: string }>) {
					if (b.type === "tool_use" && typeof b.id === "string") ids.add(b.id);
				}
			}
			result.push(msg);
			pending = ids.size > 0 ? ids : null;
			continue;
		}
		const blocks = Array.isArray(msg.content) ? msg.content as Array<{ type?: string; tool_use_id?: string }> : null;
		const hasToolResults = blocks?.some((b) => b.type === "tool_result") ?? false;
		if (!pending && !hasToolResults) {
			result.push(msg);
			continue;
		}
		const input = blocks ?? (typeof msg.content === "string" && msg.content ? [{ type: "text", text: msg.content }] : []);
		const provided = new Set<string>();
		const kept = input.filter((b: { type?: string; tool_use_id?: string }) => {
			if (b.type !== "tool_result") return true;
			if (b.tool_use_id && pending?.has(b.tool_use_id)) {
				provided.add(b.tool_use_id);
				return true;
			}
			return false;
		});
		if (pending) {
			const missing = [...pending].filter((id) => !provided.has(id)).map(synthetic);
			kept.unshift(...missing);
			pending = null;
		}
		if (kept.length === 0) {
			if (result.length === 0) {
				result.push({ role: "user", content: [{ type: "text", text: "[orphaned tool result removed]" }] });
			}
			continue;
		}
		result.push({ ...msg, content: kept });
	}
	flushPending();
	return result;
}

export function readSession(sessionId: string, projectPath: string, codebuddyDir?: string): Session | null {
	const jsonlPath = getSessionPath(sessionId, projectPath, codebuddyDir);
	if (!existsSync(jsonlPath)) return null;
	const session = new Session(sessionId, projectPath, codebuddyDir);
	const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
	for (const line of lines) {
		try {
			const rec = JSON.parse(line);
			if (rec.type === "message" && rec.role === "user") {
				const text = rec.content?.find((b: any) => b.type === "input_text")?.text ?? messageContentToText(rec.content);
				session.messages.push({ role: "user", content: text });
			} else if (rec.type === "message" && rec.role === "assistant") {
				const text = rec.content?.find((b: any) => b.type === "output_text")?.text ?? messageContentToText(rec.content);
				session.messages.push({ role: "assistant", content: text });
			}
		} catch { /* skip malformed */ }
	}
	return session;
}
