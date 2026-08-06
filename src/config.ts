import type { SettingSource } from "./index-types.js";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function redactPath(path: string): string {
	const home = homedir();
	return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

export const CONFIG_BASENAME = "codebuddy-sdk.json";

export interface Config {
	askCodebuddy?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	provider?: {
		appendSystemPrompt?: boolean;
		settingSources?: SettingSource[];
		strictMcpConfig?: boolean;
		pathToCodebuddyCode?: string;
		/** Override the estimated context window (tokens) for ALL models. */
		contextWindow?: number;
		/** Override the estimated max output tokens for ALL models. */
		maxTokens?: number;
		/** Per-model overrides keyed by model id (or id substring). */
		modelOverrides?: Record<string, {
			contextWindow?: number;
			maxTokens?: number;
			reasoning?: boolean;
			images?: boolean;
		}>;
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`codebuddy-sdk: failed to parse ${redactPath(path)}: ${e}`);
		return {};
	}
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(join(homedir(), ".pi", "agent", CONFIG_BASENAME));
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, CONFIG_BASENAME));
	return {
		askCodebuddy: { ...global.askCodebuddy, ...project.askCodebuddy },
		provider: { ...global.provider, ...project.provider },
	};
}
