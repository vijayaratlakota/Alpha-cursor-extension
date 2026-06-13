import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // jsdom is required for DOM-touching tests (Shadow DOM UI, content scripts).
    environment: "jsdom",
    globals: true,
    // Property-based tests live next to the code they validate.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // fast-check property tests run a minimum of 100 cases; give them room.
    testTimeout: 20000,
  },
});
