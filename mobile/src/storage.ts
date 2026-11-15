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

function isPairedPc(value: unknown): value is PairedPc {
  if (typeof value !== "object" || value === null) return false;
  const pc = value as Record<string, unknown>;
  const texts = [pc.pcId, pc.pcPub, pc.pcName, pc.deviceId].every((field) => typeof field === "string");
  return texts && Array.isArray(pc.hosts) && pc.hosts.every((host) => typeof host === "string");
}

export async function loadPc(): Promise<PairedPc | null> {
  try {
    const raw = await SecureStore.getItemAsync(PC_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    // A damaged entry counts as "not paired": pairing again repairs it, a crash on `hosts` wouldn't.
    return isPairedPc(value) ? value : null;
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

/**
 * Stores the keys of a new pairing. The approval key goes first: writing it asks for
 * the fingerprint, and if the user cancels there nothing of an earlier pairing has
 * been overwritten yet.
 */
export async function saveKeys(deviceSecret: Uint8Array, approvalKey: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(APPROVAL_KEY, b64(approvalKey), { requireAuthentication: true, authenticationPrompt: "Schlüssel für Freigaben sichern" });
  await SecureStore.setItemAsync(DEVICE_SECRET, b64(deviceSecret));
}

export type ApprovalKey = { key: Uint8Array } | { missing: "cancelled" | "lost" };

/**
 * Asks for the fingerprint or face. "lost" means Android threw the key away, which it
 * does when the fingerprints on the phone change: only pairing again brings one back.
 */
export async function approvalKey(): Promise<ApprovalKey> {
  try {
    const value = await SecureStore.getItemAsync(APPROVAL_KEY, { requireAuthentication: true, authenticationPrompt: "Freigabe bestätigen" });
    return value ? { key: unb64(value) } : { missing: "lost" };
  } catch {
    return { missing: "cancelled" };
  }
}

export async function forgetPc(): Promise<void> {
  await Promise.all([PC_KEY, DEVICE_SECRET, APPROVAL_KEY].map((key) => SecureStore.deleteItemAsync(key)));
  await saveState({ ...emptyState, hiddenTasks: [] });
}

/** The saved part of the app's state: the protocol's, and what the user hid on the Tasks tab. */
export interface SavedState extends PhoneState {
  hiddenTasks: string[];
}

const stateFile = () => new File(Paths.document, "nova-companion.json");

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Chat, tasks and the outbox survive a restart; approvals don't (they expire anyway). */
export async function loadState(): Promise<SavedState> {
  const empty: SavedState = { ...emptyState, hiddenTasks: [] };
  try {
    const file = stateFile();
    if (!file.exists) return empty;
    const saved = JSON.parse(await file.text()) as Record<string, unknown>;
    return { ...empty, chat: list(saved.chat), tasks: list(saved.tasks), outbox: list(saved.outbox), hiddenTasks: list<unknown>(saved.hiddenTasks).filter((id): id is string => typeof id === "string") };
  } catch {
    return empty;
  }
}

export async function saveState(state: SavedState): Promise<void> {
  const { chat, tasks, outbox, hiddenTasks } = state;
  // Screenshots stay out of the file: they are large and only for the moment.
  const light = chat.map((entry) => (entry.screenshot ? { ...entry, screenshot: null } : entry));
  try {
    await stateFile().write(JSON.stringify({ chat: light, tasks, outbox, hiddenTasks }));
  } catch {
    // Saving is best effort; the PC keeps the real log.
  }
}
