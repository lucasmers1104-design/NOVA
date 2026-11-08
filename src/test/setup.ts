import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  // Absent in tests that run in the node environment (packages/).
  globalThis.localStorage?.clear();
});
