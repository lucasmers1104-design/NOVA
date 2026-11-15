// Tests for the app's own logic: the pure rules (src/logic.ts) and the store with
// its connection (src/store.ts) against stand-ins for the phone. Everything that
// needs React Native or a device stays out; the shared protocol package has its own
// tests in the repository root (`npm test` there).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
