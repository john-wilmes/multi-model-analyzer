import { defineConfig } from "vitest/config";

export default defineConfig({
  bench: {
    include: ["packages/**/src/**/*.bench.ts", "apps/*/src/**/*.bench.ts"],
  },
  test: {
    pool: "forks",
    // poolOptions.forks.maxForks moved to top-level forks option in Vitest 4
    forks: { maxForks: 1 },
    // Suppress tinypool "Channel closed" teardown race (ERR_IPC_CHANNEL_CLOSED)
    // that causes vitest to exit 1 despite all tests passing.
    dangerouslyIgnoreUnhandledErrors: true,
    globals: true,
    include: ["packages/**/src/**/*.test.ts", "apps/cli/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "**/dist/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
