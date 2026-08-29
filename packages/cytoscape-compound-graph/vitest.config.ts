import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dgillard/cytoscape-compound-graph": path.resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "tests/**"],
      reporter: ["text", "text-summary", "html", "lcov", "json-summary"],
      thresholds: {
        lines: 98,
        branches: 98,
      },
    },
  },
});
