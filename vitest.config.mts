import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    projects: ["packages/core/vitest.config.mts", "packages/desktop-files/vitest.config.mts", "plugins/harness/vitest.config.mts", "plugins/opencode/vitest.config.mts"],
  },
});
