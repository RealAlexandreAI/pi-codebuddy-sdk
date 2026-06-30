import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ponytail: hardcoded patterns for capability detection since supportedModels() returns
// only {id, name} without capability metadata.
const THINKING_PATTERNS = [/claude/i, /gemini/i, /gpt-5/i];
const IMAGE_PATTERNS = [/claude/i, /gemini/i, /gpt/i];
// ponytail: rough context window estimates by model family
const CONTEXT_ESTIMATES: Record<string, [number, number]> = {
  // [contextWindow, maxTokens]
  claude: [200000, 8192],
  gemini: [1048576, 8192],
  gpt: [200000, 16384],
  deepseek: [131072, 8192],
  glm: [131072, 8192],
  minimax: [131072, 8192],
  kimi: [131072, 8192],
  hy: [131072, 8192], // Hunyuan
};

function detectCapabilities(modelId: string) {
  const reasoning = THINKING_PATTERNS.some((p) => p.test(modelId));
  const hasImage = IMAGE_PATTERNS.some((p) => p.test(modelId));

  // Match family for context window estimate
  const family = Object.keys(CONTEXT_ESTIMATES).find((k) =>
    modelId.toLowerCase().startsWith(k),
  );
  const [contextWindow, maxTokens] = family
    ? CONTEXT_ESTIMATES[family]
    : [128000, 8192];

  return {
    reasoning,
    input: (hasImage ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    contextWindow,
    maxTokens,
  };
}

async function discoverModels(): Promise<ProviderModelConfig[]> {
  try {
    const sdk = await import("@tencent-ai/agent-sdk");
    const q = sdk.query({
      prompt: "",
      options: {
        permissionMode: "bypassPermissions",
        maxTurns: 0,
      },
    });
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("CodeBuddy model discovery timed out after 15s")), 15000),
      ),
    ]);
    if (models && models.length > 0) {
      return models.map((m) => {
        const caps = detectCapabilities(m.id);
        return {
          id: m.id,
          name: m.name || m.id,
          reasoning: caps.reasoning,
          input: caps.input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: caps.contextWindow,
          maxTokens: caps.maxTokens,
        };
      });
    }
  } catch (e) {
    // Discovery failed — SDK not installed, CLI missing, or network issue.
    // Fall back to hardcoded minimal list so Pi can still show a provider.
    console.warn(
      `[pi-codebuddy-sdk] Model discovery failed: ${e instanceof Error ? e.message : String(e)}. Using ${3} fallback models.`,
    );
  }

  // ponytail: fallback model list when discovery fails
  return [
    { id: "hy3-preview-agent-ioa", name: "Hunyuan 3 Preview", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 },
    { id: "deepseek-v4-pro-ioa", name: "DeepSeek V4 Pro", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  ];
}

export default async function (pi: ExtensionAPI) {
  const models = await discoverModels();

  pi.registerProvider("codebuddy", {
    name: "CodeBuddy",
    baseUrl: "https://codebuddy.ai",
    apiKey: "codebuddy-local",
    api: "codebuddy-sdk",
    models,
    streamSimple: (await import("./provider.js")).streamCodebuddy,
  });
}
