/**
 * Tests for CodeBuddy model helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildModels, codebuddyModelId, rawModelsFromSdk, resolveModel, FALLBACK_MODELS } from "../src/models.js";

describe("rawModelsFromSdk", () => {
	it("maps SDK ModelInfo to pi models", () => {
		const models = rawModelsFromSdk([
			{ value: "hy3-preview-agent-ioa", displayName: "Hunyuan 3", description: "" },
			{ id: "claude-sonnet-4.6", name: "Claude Sonnet", description: "" },
		]);
		assert.equal(models[0].id, "hy3-preview-agent-ioa");
		assert.equal(models[1].input.includes("image"), true);
		assert.deepEqual(models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});

describe("buildModels", () => {
	it("preserves order from SDK", () => {
		const models = buildModels(rawModelsFromSdk([
			{ value: "model-b", displayName: "B", description: "" },
			{ value: "model-a", displayName: "A", description: "" },
		]));
		assert.deepEqual(models.map((m) => m.id), ["model-b", "model-a"]);
	});

	it("applies global contextWindow/maxTokens overrides", () => {
		const models = buildModels(
			rawModelsFromSdk([{ value: "hy3-preview-agent-ioa", displayName: "H", description: "" }]),
			{ contextWindow: 300_000, maxTokens: 32_768 },
		);
		assert.equal(models[0].contextWindow, 300_000);
		assert.equal(models[0].maxTokens, 32_768);
	});

	it("applies per-model overrides and lets them beat globals", () => {
		const models = buildModels(
			rawModelsFromSdk([
				{ value: "claude-sonnet", displayName: "Sonnet", description: "" },
				{ value: "gpt-5", displayName: "GPT-5", description: "" },
			]),
			{ contextWindow: 200_000 },
			{ "gpt-5": { contextWindow: 1_048_576, maxTokens: 64_000, reasoning: true, images: false } },
		);
		assert.equal(models[0].contextWindow, 200_000); // global applies
		assert.equal(models[1].contextWindow, 1_048_576); // per-model wins
		assert.equal(models[1].maxTokens, 64_000);
		assert.equal(models[1].reasoning, true);
		assert.deepEqual(models[1].input, ["text"]); // images=false
	});

	it("matches per-model override by substring (longest key wins)", () => {
		const models = buildModels(
			rawModelsFromSdk([{ value: "gpt-5-max", displayName: "M", description: "" }]),
			undefined,
			{ gpt: { maxTokens: 8_192 }, "gpt-5-max": { maxTokens: 128_000 } },
		);
		assert.equal(models[0].maxTokens, 128_000);
	});
});

describe("codebuddyModelId", () => {
	it("returns model id unchanged", () => {
		assert.equal(codebuddyModelId({ id: "hy3-preview-agent-ioa" }), "hy3-preview-agent-ioa");
	});
});

describe("resolveModel", () => {
	const models = buildModels(FALLBACK_MODELS);

	it("resolves by partial id", () => {
		assert.equal(resolveModel(models, "hy3")?.id, "hy3-preview-agent-ioa");
	});

	it("returns undefined when no match", () => {
		assert.equal(resolveModel(models, "gpt-9"), undefined);
	});
});
