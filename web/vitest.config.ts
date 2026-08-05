import { defineConfig } from "vitest/config"

/**
 * The UI's own suite, which is deliberately not a UI suite.
 *
 * Everything on the cockpit is derived from one array of events by two pure functions — what the
 * run currently is, and which columns a table of the model's own field names should show. Those
 * carry the logic; the components around them are markup. So there is no jsdom and nothing renders
 * here: these tests take an array in and assert on what comes out, which is the whole of what could
 * be wrong.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
})
