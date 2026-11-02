import { invoke, isTauri } from "@tauri-apps/api/core";

/** Thrown when native functionality is requested outside the desktop runtime. */
export class NativeUnavailableError extends Error {
  constructor(command: string) {
    super(`"${command}" requires the NOVA desktop runtime.`);
    this.name = "NativeUnavailableError";
  }
}

export function isDesktop(): boolean {
  return isTauri();
}

/** Invokes a registered Tauri command; rejects with a typed error in a plain browser. */
export async function callNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new NativeUnavailableError(command);
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    // Rust commands reject with plain strings; normalize to Error.
    throw error instanceof Error ? error : new Error(String(error));
  }
}
