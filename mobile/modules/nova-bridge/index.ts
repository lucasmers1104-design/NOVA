// NOVA Companion's Android module (android/src/main/java/dev/nova/bridge). On iOS, in
// Expo Go or in an app built before 1.1.0 it is missing: every call then says so
// instead of failing, and the app hides what needs it.
import { type EventSubscription, requireOptionalNativeModule } from "expo";

export interface BridgeNotification {
  key: string;
  app: string;
  appName: string;
  title: string;
  text: string;
  icon: string | null;
  posted: number;
}

export interface BridgeCall {
  callId: string;
  state: "ringing" | "active" | "ended";
  name: string | null;
  number: string | null;
  photo: string | null;
  canAnswer: boolean;
  canDecline: boolean;
}

interface NovaBridgeNative {
  hasNotificationAccess(): boolean;
  openNotificationAccess(): void;
  configure(notifications: boolean, calls: boolean, onlyAppNames: boolean, skipSilent: boolean): void;
  mayAnswerCalls(): boolean;
  callAction(callId: string, action: "accept" | "decline"): Promise<boolean>;
  activeCalls(): { callId: string; ringing: boolean }[];
  canInstallUpdates(): boolean;
  openInstallPermission(): void;
  installApk(contentUri: string): void;
  /** SHA-256 of a file (file:// or content:// URI) as lowercase hex, read in pieces so a large APK never sits in memory. */
  fileSha256(uri: string): Promise<string>;
  addListener(event: "onNotification", listener: (notification: BridgeNotification) => void): EventSubscription;
  addListener(event: "onCall", listener: (call: BridgeCall) => void): EventSubscription;
}

export const NovaBridge = requireOptionalNativeModule<NovaBridgeNative>("NovaBridge");

/** The module is in this build of the app. */
export const bridgeAvailable = NovaBridge !== null;
