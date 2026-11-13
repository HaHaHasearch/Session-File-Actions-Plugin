import { defineConfig } from "tsdown";

const bundled = [/^@session-file-actions\/core$/, /^@deepseek-ai\/dsh-(?:session|brand|util-values)(?:\/|$)/];

export default defineConfig([
  {
    entry: { index: "src/host/index.ts" },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "node24",
    fixedExtension: false,
    clean: false,
    deps: { alwaysBundle: bundled },
  },
  {
    entry: { client: "src/client/index.ts" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    target: "es2024",
    fixedExtension: false,
    clean: false,
    deps: { alwaysBundle: bundled },
    outputOptions: {
      entryFileNames: "client.js",
      banner: 'window.__ModuleLoader__.load({ id: "dsh-session-file-actions", factory: (require) => {',
      intro: "var module = { exports: {} }; var exports = module.exports;",
      footer: "return module.exports; } });",
    },
  },
]);
