import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../../../src/tests",
  testMatch: "vscode-sidebar-screenshots.spec.ts",
  timeout: 30000,
  retries: 0,
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  outputDir: "../../../test-results/vscode-screenshots",
  reporter: [["list"]],
});
