import { defineConfig } from "vitest/config";

export default defineConfig({
  bench: {
    include: ["packages/**/src/**/*.bench.ts", "apps/*/src/**/*.bench.ts"],
  },
  test: {
    pool: "forks",
    poolOptions: { forks: { maxForks: 1 } },
    globals: true,
    include: ["packages/**/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "**/dist/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
