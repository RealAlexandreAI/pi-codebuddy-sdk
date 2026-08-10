// Persisted last-known-good model list.
//
// `pi -r` after exiting pi spawns a NEW process: the Symbol.for in-process
// cache from v0.4.0 dies with the old process, so a session-resume model
// resolution that runs while SDK discovery is still in flight only sees the
// fallback list and the previously selected codebuddy model drops out of
// /model (user must re-pick it). Persisting the list to disk lets the new
// process register the full model list synchronously at module load.

import { homedir } from "os";
import { dirname, join } from "path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import type { PiModel } from "./models.js";

export const MODELS_CACHE_KEY = Symbol.for("codebuddy-sdk:modelsCache");

const defaultCacheFile = () => join(homedir(), ".pi", "agent", "codebuddy-sdk-models.json");

// Injectable for tests.
const cacheFile = () => process.env.CODEBUDDY_SDK_MODELS_CACHE_PATH || defaultCacheFile();

export function readModelsCache(): PiModel[] | undefined {
	// In-process shared cache first (module reloads within a process).
	const inProcess = (globalThis as Record<symbol, unknown>)[MODELS_CACHE_KEY] as PiModel[] | undefined;
	if (inProcess?.length) return inProcess;
	// Disk cache second (new process — `pi -r` after exiting pi).
	try {
		const parsed: unknown = JSON.parse(readFileSync(cacheFile(), "utf8"));
		if (Array.isArray(parsed) && parsed.length) return parsed as PiModel[];
	} catch {
		// No cache yet, or corrupt file — caller falls back.
	}
	return undefined;
}

export function writeModelsCache(models: PiModel[]): void {
	if (!models.length) return;
	(globalThis as Record<symbol, unknown>)[MODELS_CACHE_KEY] = models;
	try {
		const path = cacheFile();
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(models));
		renameSync(tmp, path);
	} catch {
		// Cache is best-effort; discovery retries next load.
	}
}
