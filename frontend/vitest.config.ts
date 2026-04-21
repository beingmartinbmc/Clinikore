import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest runs in a JSDOM environment with globals enabled so tests can use
// `describe` / `it` / `expect` without importing them. Coverage uses v8 and
// is limited to the source files that ship with the app.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/tests/setup.ts"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/tests/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "**/*.d.ts",
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
