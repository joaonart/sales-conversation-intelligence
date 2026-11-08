import { defineConfig } from "vitest/config";

// The server and the pure client logic run in node; a component test opts into a DOM with `// @vitest-environment happy-dom` on its first line.
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  test: { include: ["tests/**/*.test.{ts,tsx}"], environment: "node" },
});
