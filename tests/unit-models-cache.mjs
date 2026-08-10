/**
 * Tests for the persisted model cache (src/models-cache.js).
 *
 * The disk cache exists so a NEW pi process (`pi -r` after exit) can recover
 * the last-known-good model list synchronously at module load — the
 * in-process Symbol.for global alone dies with the old process.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelsCache, writeModelsCache, MODELS_CACHE_KEY } from "../src/models-cache.js";
import { FALLBACK_MODELS, rawModelsFromSdk } from "../src/models.js";

const SAMPLE = rawModelsFromSdk([
	{ value: "hy3-preview-agent-ioa", displayName: "Hunyuan 3", description: "" },
	{ value: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", description: "" },
]);

let tmp;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "cb-cache-"));
	process.env.CODEBUDDY_SDK_MODELS_CACHE_PATH = join(tmp, "models.json");
	// Clear the in-process global so each test exercises the disk path.
	delete globalThis[MODELS_CACHE_KEY];
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	delete process.env.CODEBUDDY_SDK_MODELS_CACHE_PATH;
	delete globalThis[MODELS_CACHE_KEY];
});

describe("writeModelsCache / readModelsCache", () => {
	it("round-trips through disk after the in-process global is cleared", () => {
		writeModelsCache(SAMPLE);
		delete globalThis[MODELS_CACHE_KEY];
		const loaded = readModelsCache();
		assert.ok(loaded, "expected a recovered model list");
		assert.deepEqual(loaded.map((m) => m.id), ["hy3-preview-agent-ioa", "deepseek-v4-flash"]);
	});

	it("returns undefined when no cache file exists", () => {
		assert.equal(readModelsCache(), undefined);
	});

	it("returns undefined for a corrupt cache file", () => {
		writeFileSync(process.env.CODEBUDDY_SDK_MODELS_CACHE_PATH, "not json {{{");
		assert.equal(readModelsCache(), undefined);
	});

	it("serves the in-process global without touching disk", () => {
		writeModelsCache(FALLBACK_MODELS);
		// in-process global is populated by writeModelsCache; delete the file
		rmSync(process.env.CODEBUDDY_SDK_MODELS_CACHE_PATH, { force: true });
		const loaded = readModelsCache();
		assert.deepEqual(loaded.map((m) => m.id), FALLBACK_MODELS.map((m) => m.id));
	});
});
