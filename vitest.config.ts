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
    // That is the actual fix, and it is enough on a machine one person is using. A retry on top of
    // it buys a green run at the price of the signal: the two newest features here are themselves
    // retry loops — the launch that is asked for twice, the page re-read after it moves — so a
    // global retry hides genuine nondeterminism in exactly the code most likely to have it, and
    // hides it by passing. Kept only where nobody is watching the run and the cores are shared.
    //
    // A test that passes on the retry is a bug to file, not a run to accept: it is either a race
    // in the code under test or a race in the test, and both are worth the ten minutes.
    retry: process.env.CI ? 1 : 0,
  },
})
