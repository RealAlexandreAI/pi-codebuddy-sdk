// Dynamic model list from CodeBuddy SDK supportedModels().

import type { ModelInfo } from "@tencent-ai/agent-sdk";

export type PiModel = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string>;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

const DEFAULT_CONTEXT = 131_072;
const DEFAULT_MAX_TOKENS = 8192;

function detectThinking(id: string): boolean {
	return /claude|gemini|gpt-5|hy3|deepseek|glm/i.test(id);
}

function detectImages(id: string): boolean {
	return /claude|gemini|gpt/i.test(id);
}

function estimateContext(id: string): number {
	const lower = id.toLowerCase();
	if (lower.includes("gemini")) return 1_048_576;
	if (lower.includes("claude") || lower.includes("gpt")) return 200_000;
	return DEFAULT_CONTEXT;
}

function estimateMaxTokens(id: string): number {
	if (id.toLowerCase().includes("gpt")) return 16_384;
	return DEFAULT_MAX_TOKENS;
}

export function rawModelsFromSdk(supported: Array<ModelInfo & { id?: string; name?: string }>): PiModel[] {
	return supported
		.map((m) => ({ id: m.id ?? m.value, name: m.name ?? m.displayName ?? m.id ?? m.value }))
		.filter((m) => m.id)
		.map((m) => ({
		id: m.id!,
		name: m.name || m.id!,
		reasoning: detectThinking(m.id!),
		input: detectImages(m.id!) ? ["text", "image"] as const : ["text"] as const,
		contextWindow: estimateContext(m.id!),
		maxTokens: estimateMaxTokens(m.id!),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
}

export const FALLBACK_MODELS: PiModel[] = [
	{ id: "hy3-preview-agent-ioa", name: "Hunyuan 3 Preview", reasoning: true, input: ["text"], contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX_TOKENS, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
];

export type ModelOverrides = {
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	images?: boolean;
};

/**
 * Apply config-driven overrides on top of the estimated model metadata.
 * `globalOverrides` applies to every model; `perModel` is keyed by model id
 * (matched by exact id first, then case-insensitive substring, longest key
 * wins) and beats the global defaults.
 */
export function buildModels(
	models: PiModel[],
	globalOverrides?: ModelOverrides,
	perModel?: Record<string, ModelOverrides>,
): PiModel[] {
	const sortedKeys = Object.keys(perModel ?? {}).sort((a, b) => b.length - a.length);
	const match = (id: string): ModelOverrides | undefined => {
		const lower = id.toLowerCase();
		for (const key of sortedKeys) {
			const k = key.toLowerCase();
			if (id === key || (lower.includes(k) && k.length > 0)) return perModel![key];
		}
		return undefined;
	};
	return models.map((m) => {
		const o = { ...globalOverrides, ...match(m.id) };
		const contextWindow = o.contextWindow ?? m.contextWindow;
		const maxTokens = o.maxTokens ?? m.maxTokens;
		const input: ("text" | "image")[] = o.images === undefined
			? m.input
			: (o.images ? ["text", "image"] as const : ["text"] as const);
		return {
			...m,
			contextWindow,
			maxTokens,
			reasoning: o.reasoning ?? m.reasoning,
			input,
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	});
}

export function codebuddyModelId(model: { id: string }): string {
	return model.id;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.toLowerCase().includes(lower));
}
