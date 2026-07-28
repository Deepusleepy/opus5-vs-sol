import { defineConfig } from "vitest/config";

// JSX is transformed by the bundled oxc transform, which picks up
// `"jsx": "react-jsx"` from tsconfig.json — no extra transform config needed.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
