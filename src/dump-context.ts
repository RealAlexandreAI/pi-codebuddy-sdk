/**
 * Check what Pi actually injects into Context.messages.
 * Logs all messages with their role and first 100 chars of content.
 */
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

// Register a fake provider to intercept Context
// We can't easily intercept Context without running Pi, so let's just
// dump what our extension sees when loaded from Pi.
console.log("Run this from Pi: pi -e src/dump-context.ts --provider codebuddy --model hy3-preview-agent-ioa -p 'test'");
console.log("Then check the console output for injected messages.");
