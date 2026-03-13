import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["validation/models/**/*.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
