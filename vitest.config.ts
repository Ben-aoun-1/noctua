import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    // Three of these files drive a real Chromium, and one asserts on how promptly a live SSE
    // frame arrives. Run files one at a time: in parallel they compete for the same cores and
    // the timing-sensitive assertions fail on a busy machine while passing alone, which reads
    // as a broken suite rather than a loaded one. The whole run still finishes in about a minute.
    fileParallelism: false,
    // And one retry on top of that. A real failure still fails twice — this only absorbs the
    // case where a browser-driven test loses a race to whatever else the machine is doing.
    retry: 1,
  },
})
