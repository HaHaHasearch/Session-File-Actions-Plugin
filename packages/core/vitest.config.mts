import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    exclude: [...configDefaults.exclude, ".scratch/**", "upstream/**"],
  },
});
