// What the phone keeps. Keys in the Android Keystore (expo-secure-store), the chat
// and the outbox as a file in the app's own storage.
//
// SECURITY: the approval key is stored with `requireAuthentication`, so Android only
// hands it out after a fingerprint or face check: an approval can't be made without it.

import { type Identity } from "@nova/companion-protocol/client";
import { b64, unb64 } from "@nova/companion-protocol/crypto";
import { emptyState, type PhoneState } from "@nova/companion-protocol/state";
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

const PC_KEY = "nova.pc";
const DEVICE_SECRET = "nova.deviceSecret";
const APPROVAL_KEY = "nova.approvalKey";

export interface PairedPc {
  pcId: string;
  pcPub: string;
  pcName: string;
  deviceId: string;
  /** Addresses that answered, the last good one first. */
  hosts: string[];
}

export async function loadPc(): Promise<PairedPc | null> {
  const raw = await SecureStore.getItemAsync(PC_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PairedPc;
  } catch {
    return null;
  }
}

export async function savePc(pc: PairedPc): Promise<void> {
  await SecureStore.setItemAsync(PC_KEY, JSON.stringify(pc));
}

export async function identity(pc: PairedPc): Promise<Identity | null> {
  const secret = await SecureStore.getItemAsync(DEVICE_SECRET);
  return secret ? { pcId: pc.pcId, pcPub: unb64(pc.pcPub), deviceId: pc.deviceId, deviceSecret: unb64(secret) } : null;
}

export async function saveKeys(deviceSecret: Uint8Array, approvalKey: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(DEVICE_SECRET, b64(deviceSecret));
  await SecureStore.setItemAsync(APPROVAL_KEY, b64(approvalKey), { requireAuthentication: true, authenticationPrompt: "Schlüssel für Freigaben sichern" });
}

/** Asks for the fingerprint or face; `null` if the user cancelled. */
export async function approvalKey(): Promise<Uint8Array | null> {
  const value = await SecureStore.getItemAsync(APPROVAL_KEY, { requireAuthentication: true, authenticationPrompt: "Freigabe bestätigen" });
  return value ? unb64(value) : null;
}

export async function forgetPc(): Promise<void> {
  await Promise.all([PC_KEY, DEVICE_SECRET, APPROVAL_KEY].map((key) => SecureStore.deleteItemAsync(key)));
  await saveState(emptyState);
}

const stateFile = () => new File(Paths.document, "nova-companion.json");

/** Chat, tasks and the outbox survive a restart; approvals don't (they expire anyway). */
export async function loadState(): Promise<PhoneState> {
  try {
    const file = stateFile();
    if (!file.exists) return emptyState;
    const saved = JSON.parse(await file.text()) as Partial<PhoneState>;
    return { ...emptyState, chat: saved.chat ?? [], tasks: saved.tasks ?? [], outbox: saved.outbox ?? [] };
  } catch {
    return emptyState;
  }
}

export async function saveState(state: PhoneState): Promise<void> {
  const { chat, tasks, outbox } = state;
  // Screenshots stay out of the file: they are large and only for the moment.
  const light = chat.map((entry) => (entry.screenshot ? { ...entry, screenshot: null } : entry));
  try {
    await stateFile().write(JSON.stringify({ chat: light, tasks, outbox }));
  } catch {
    // Saving is best effort; the PC keeps the real log.
  }
}
