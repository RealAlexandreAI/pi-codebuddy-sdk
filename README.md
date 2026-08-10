# pi-codebuddy-sdk

Pi extension that registers **CodeBuddy** as a model provider. You keep using Pi for the TUI, tools, skills, and extensions; CodeBuddy Agent SDK runs inference locally via the `codebuddy` CLI. No HTTP proxy and no changes to how you work in Pi beyond picking a model.

## What it does

- Exposes CodeBuddy models in Pi (`codebuddy/...` in `/model`)
- Bridges Pi tools to the SDK (Pi still executes tools; CodeBuddy only plans and calls them)
- Forwards Pi's system prompt, skills, and project `AGENTS.md` so the model acts as Pi—not as standalone CodeBuddy Code
- Supports session resume, compaction, streaming, thinking levels, and images
- Optional **AskCodebuddy** tool to delegate a focused sub-task to another CodeBuddy call

## Install

```bash
pi install npm:pi-codebuddy-sdk
```

Restart `pi` if it was already running.

## Requirements

- **`codebuddy` on your `PATH`** — the extension spawns the same CLI you use standalone. If `which codebuddy` fails, either add it to `PATH` or set `pathToCodebuddyCode` in `codebuddy-sdk.json` (see [Configuration](#configuration)).
- **CodeBuddy auth already working** — if `codebuddy` works in your terminal, you do not need extra setup for this extension.

## Quick start (already using CodeBuddy)

No `codebuddy-sdk.json` and no plugin-specific env vars are required.

1. `pi install npm:pi-codebuddy-sdk`
2. Restart `pi`
3. `/model` → pick `codebuddy/...`

Optional: set `defaultProvider` / `defaultModel` in `~/.pi/agent/settings.json` so you skip `/model` each time.

The first query after startup may take a few seconds while models are discovered from the SDK.

## Auth

The extension does not store credentials. The CodeBuddy CLI reads them from your machine. Use **one** of the following:

### 1. CLI login (recommended)

```bash
codebuddy login
```

Complete login in the browser. Credentials stay on your machine; Pi reuses them automatically.

### 2. API key

```bash
export CODEBUDDY_API_KEY="your-api-key"
```

Obtain the key from your CodeBuddy account. Do not commit it or store it in repo files.

### 3. Tencent iOA (internal network)

```bash
export CODEBUDDY_INTERNET_ENVIRONMENT=ioa
codebuddy login
```

Use this when CodeBuddy must run on the iOA network. Add `CODEBUDDY_API_KEY` as well if your environment requires it.

## Usage

```text
pi
/model
```

Pick any entry prefixed with `codebuddy/` (for example `codebuddy/hy3-preview-agent-ioa`).

Tools, skills, extensions, `/compact`, and steer behave the same as with other Pi providers.

## Configuration

**Optional.** Defaults work for most users.

File: `~/.pi/agent/codebuddy-sdk.json` or `.pi/codebuddy-sdk.json` in a project.

```json
{
  "askCodebuddy": {
    "enabled": true,
    "allowFullMode": true
  },
  "provider": {
    "appendSystemPrompt": true,
    "strictMcpConfig": true,
    "pathToCodebuddyCode": "/path/to/codebuddy"
  }
}
```

| Option | Default | Meaning |
|--------|---------|---------|
| `askCodebuddy.enabled` | `true` | Register the AskCodebuddy delegation tool |
| `askCodebuddy.allowFullMode` | `true` | Allow write-capable delegation mode |
| `provider.appendSystemPrompt` | `true` | Use Pi's system prompt instead of CodeBuddy's default identity |
| `provider.strictMcpConfig` | `true` | Use only Pi-bridged MCP tools |
| `provider.pathToCodebuddyCode` | auto | Path to `codebuddy` when it is **not** on `PATH` |
| `provider.contextWindow` | estimated | Override context window (tokens) for **all** models (e.g. `300000`) |
| `provider.maxTokens` | estimated | Override max output tokens for **all** models (e.g. `32768`) |
| `provider.modelOverrides` | — | Per-model overrides, keyed by model id or substring (see below) |

`modelOverrides` lets you fine-tune individual models; the longest matching
key wins and beats the global `contextWindow` / `maxTokens`:

```json
{
  "provider": {
    "modelOverrides": {
      "gpt-5": { "contextWindow": 1048576, "maxTokens": 64000, "images": false },
      "claude": { "reasoning": true }
    }
  }
}
```

Supported per-model keys: `contextWindow`, `maxTokens`, `reasoning`, `images`.

## Privacy

- The extension does **not** send conversation data to this repository or any third-party telemetry endpoint.
- Credentials are handled entirely by the CodeBuddy CLI on your machine.
- Optional debug mode (`CODEBUDDY_SDK_DEBUG=1`) writes **local** logs under `~/.pi/agent/`; paths are redacted, prompts and tool payloads are not logged. Delete logs when finished.

## Troubleshooting

```bash
export CODEBUDDY_SDK_DEBUG=1
```

Default log: `~/.pi/agent/codebuddy-sdk.log`. See [CONTRIBUTING.md](CONTRIBUTING.md) for maintainer details.

**After `pi -r`, the previously selected codebuddy model is gone from `/model`?**
The last-known-good model list is cached to `~/.pi/agent/codebuddy-sdk-models.json` on every
successful discovery, so a new pi process can re-register it synchronously at module load —
even when SDK discovery is still in flight (new process, gate busy, or stale auth). If the
model is still missing, share the debug log (`CODEBUDDY_SDK_DEBUG=1`) and the cache file.

## Development

Maintainers: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

## Inspiration

Early MCP bridge patterns were inspired by [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge). This package is a separate codebase on [@tencent-ai/agent-sdk](https://www.npmjs.com/package/@tencent-ai/agent-sdk).
