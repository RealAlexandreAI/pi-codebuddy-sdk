import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { getProjectDir, projectPathToHash } from "../src/cb-session-io.js";

describe("CodeBuddy project paths", () => {
	it("compresses Windows drive paths like the CodeBuddy CLI", () => {
		assert.equal(projectPathToHash("E:\\code\\ai-usage"), "E-code-ai-usage");
		assert.equal(projectPathToHash("C:\\Users\\alice"), "C-Users-alice");
	});

	it("compresses Unix and mixed-separator paths", () => {
		assert.equal(projectPathToHash("/home/alice/project/"), "home-alice-project");
		assert.equal(projectPathToHash("E:\\code//ai-usage\\"), "E-code-ai-usage");
		assert.equal(projectPathToHash("\\\\server\\share\\project"), "server-share-project");
	});

	it("keeps Windows project paths inside the CodeBuddy projects directory", () => {
		const configDir = join("tmp", "codebuddy-config");
		assert.equal(
			getProjectDir("E:\\code\\ai-usage", configDir),
			join(configDir, "projects", "E-code-ai-usage"),
		);
	});
});
