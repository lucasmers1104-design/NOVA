// Notifications and calls from this phone to Nova Island on the PC (NOVA 1.12).
// Android hands them to the app only after the user allowed notification access;
// what goes out is decided here, and nothing of it is stored on the phone or the PC.

import { protocolKey } from "@nova/companion-protocol/app";
import { newId } from "@nova/companion-protocol/client";
import type { CallAction, PhoneCall, PhoneMessage } from "@nova/companion-protocol";
import * as SecureStore from "expo-secure-store";
import { PermissionsAndroid, Platform } from "react-native";
import { type BridgeCall, type BridgeNotification, NovaBridge } from "../modules/nova-bridge";
import type { Appearance } from "./appearance";
import { safeSlice, type SeenApp } from "./logic";

const SETTINGS_KEY = "nova.phoneSettings";

export interface PhoneSettings {
  /** Forward notifications to Nova Island. */
  notifications: boolean;
  /** Tell the PC about calls (and let it answer them, where possible). */
  calls: boolean;
  /** Send only the app's name, never the title or text. */
  onlyAppNames: boolean;
  /** Leave out notifications Android shows silently (low importance). */
  skipSilent: boolean;
  /** Android packages whose notifications stay on the phone. */
  mutedApps: string[];
  /** Apps that sent a notification while forwarding was on, for the per-app switches. */
  seenApps: SeenApp[];
  /** Look for a new version of the app on GitHub when it starts. */
  checkUpdates: boolean;
  appearance: Appearance;
  haptics: boolean;
}

export const DEFAULT_PHONE_SETTINGS: PhoneSettings = {
  notifications: false,
  calls: false,
  onlyAppNames: false,
  skipSilent: true,
  mutedApps: [],
  seenApps: [],
  checkUpdates: true,
  appearance: "system",
  haptics: true,
};

export async function loadPhoneSettings(): Promise<PhoneSettings> {
  try {
    const raw = await SecureStore.getItemAsync(SETTINGS_KEY);
    return raw ? { ...DEFAULT_PHONE_SETTINGS, ...(JSON.parse(raw) as Partial<PhoneSettings>) } : DEFAULT_PHONE_SETTINGS;
  } catch {
    return DEFAULT_PHONE_SETTINGS;
  }
}

export async function savePhoneSettings(settings: PhoneSettings): Promise<void> {
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(settings));
}

let muted = new Set<string>();

/** Tells the Android side what may go out. */
export function applyPhoneSettings(settings: PhoneSettings): void {
  muted = new Set(settings.mutedApps);
  NovaBridge?.configure(settings.notifications, settings.calls, settings.onlyAppNames, settings.skipSilent);
}

export function hasNotificationAccess(): boolean {
  try {
    return NovaBridge?.hasNotificationAccess() ?? false;
  } catch {
    return false;
  }
}

/** Whether Android lets this app answer and end calls itself (ANSWER_PHONE_CALLS). */
export function mayAnswerCalls(): boolean {
  try {
    return NovaBridge?.mayAnswerCalls() ?? false;
  } catch {
    return false;
  }
}

/**
 * Asks Android for the right to answer and end calls. "blocked" means Android showed
 * no dialog because the user refused for good earlier.
 */
export async function requestAnswerCalls(): Promise<"granted" | "denied" | "blocked"> {
  if (Platform.OS !== "android") return "denied";
  try {
    const started = Date.now();
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ANSWER_PHONE_CALLS);
    if (result === PermissionsAndroid.RESULTS.GRANTED) return "granted";
    // Android reports "never ask again" both right after the user ticked it and when it
    // skipped the dialog. Only an answer that came back at once means no dialog was shown.
    return result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN && Date.now() - started < 400 ? "blocked" : "denied";
  } catch {
    return "denied";
  }
}

function notificationMessage(n: BridgeNotification): PhoneMessage {
  return {
    type: "phone.notification",
    id: newId(),
    ts: Date.now(),
    notifId: protocolKey(n.key),
    app: protocolKey(n.app),
    appName: safeSlice(n.appName || n.app, 100),
    title: safeSlice(n.title, 200),
    text: safeSlice(n.text, 1000),
    icon: n.icon,
    posted: Math.max(0, Math.round(n.posted)),
  };
}

function callMessage(c: BridgeCall): PhoneCall {
  return {
    type: "phone.call",
    id: newId(),
    ts: Date.now(),
    callId: protocolKey(c.callId),
    state: c.state,
    name: c.name === null ? null : safeSlice(c.name, 100),
    number: c.number === null ? null : safeSlice(c.number, 40),
    photo: c.photo,
    canAnswer: c.canAnswer,
    canDecline: c.canDecline,
  };
}

/** Calls ringing or running right now, by the key the PC names them with. */
const liveCalls = new Map<string, BridgeCall>();

/**
 * Every call in progress, as it stands now. Sent after each connect: the PC keeps
 * no record across a lost connection, and a PC that connects in the middle of a
 * call should show it. A call Android no longer lists has ended without the app
 * hearing of it; the PC is told so, or it would show that call for good.
 */
export function callSnapshot(): PhoneMessage[] {
  let active: Set<string> | null = null;
  try {
    active = NovaBridge ? new Set(NovaBridge.activeCalls().map((call) => protocolKey(call.callId))) : null;
  } catch {
    // Without Android's list the app's own record has to do.
  }
  const messages: PhoneMessage[] = [];
  for (const [key, call] of liveCalls) {
    if (active && !active.has(key)) {
      liveCalls.delete(key);
      messages.push(callMessage({ ...call, state: "ended", canAnswer: false, canDecline: false }));
    } else {
      messages.push(callMessage(call));
    }
  }
  return messages;
}

/** Forwards what Android reports; returns the function that stops it. */
export function startPhoneBridge(forward: (message: PhoneMessage) => void, onApp: (app: string, name: string) => void): () => void {
  if (!NovaBridge) return () => {};
  const subscriptions = [
    NovaBridge.addListener("onNotification", (notification) => {
      onApp(notification.app, notification.appName || notification.app);
      if (!muted.has(notification.app)) forward(notificationMessage(notification));
    }),
    NovaBridge.addListener("onCall", (call) => {
      const key = protocolKey(call.callId);
      if (call.state === "ended") liveCalls.delete(key);
      else liveCalls.set(key, call);
      forward(callMessage(call));
    }),
  ];
  return () => {
    for (const subscription of subscriptions) subscription.remove();
  };
}

/** The PC clicked "Answer" or "Decline" on Nova Island. */
export async function handleCallAction(message: CallAction): Promise<boolean> {
  const call = liveCalls.get(message.callId);
  if (!NovaBridge || !call) return false;
  try {
    return await NovaBridge.callAction(call.callId, message.action);
  } catch {
    return false;
  }
}
