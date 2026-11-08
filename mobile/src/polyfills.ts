// Hermes has no crypto.getRandomValues; expo-crypto's comes from the OS.
import { getRandomValues } from "expo-crypto";

const global = globalThis as { crypto?: { getRandomValues?: unknown } };
if (!global.crypto?.getRandomValues) {
  global.crypto = { ...global.crypto, getRandomValues };
}
