// The app's state and its one connection to the PC: connects while the app is open,
// reconnects with a growing pause, sends waiting tasks first thing.

import { CompanionError, Connection, newId, pairWithPc, type SocketFactory, type SocketLike } from "@nova/companion-protocol/client";
import { approvalProof } from "@nova/companion-protocol/crypto";
import type { ApprovalRequest, PcMessage, PhoneMessage, Schedule, TaskCreate } from "@nova/companion-protocol";
import { parsePairingCode } from "@nova/companion-protocol";
import { addTask, applyMessage, emptyState, noticeTitle, type PhoneState } from "@nova/companion-protocol/state";
import * as LocalAuthentication from "expo-local-authentication";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { create } from "zustand";
import { discover } from "./discovery";
import { approvalKey, forgetPc, identity, loadPc, loadState, type PairedPc, savePc, saveKeys, saveState } from "./storage";

export type Link = "unpaired" | "connecting" | "online" | "offline";

interface Store extends PhoneState {
  ready: boolean;
  pc: PairedPc | null;
  link: Link;
  init(): Promise<void>;
  pair(scanned: string, deviceName: string): Promise<void>;
  send(text: string, options: { schedule: Schedule; wantScreenshot: boolean; voice: boolean }): string;
  cancel(taskId: string): void;
  approve(request: ApprovalRequest): Promise<void>;
  decline(request: ApprovalRequest): void;
  refresh(): void;
  forget(): Promise<void>;
}

export const socketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

let connection: Connection | null = null;
let connecting = false;
let retry: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 2000;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let saving: ReturnType<typeof setTimeout> | null = null;

const HEARTBEAT_MS = 30_000;
const MOST_RETRY_MS = 60_000;

/** User-facing reasons, in the app's words. */
export function failureText(error: unknown): string {
  const reason = error instanceof CompanionError ? error.reason : null;
  switch (reason) {
    case "expired":
      return "Der Code ist abgelaufen. Lass dir am PC einen neuen zeigen.";
    case "used":
      return "Dieser Code wurde schon benutzt. Lass dir am PC einen neuen zeigen.";
    case "declined":
      return "Die Kopplung wurde am PC abgelehnt.";
    case "busy":
      return "Am PC sind schon zu viele Handys gekoppelt.";
    case "unreachable":
      return "Dein PC ist nicht erreichbar. Seid ihr im selben WLAN?";
    case "timeout":
      return "Dein PC hat nicht rechtzeitig geantwortet.";
    case "invalid":
    case "rejected":
      return "Das hat nicht geklappt. Versuch es mit einem neuen Code.";
    default:
      return error instanceof Error && error.message ? error.message : "Etwas ist schiefgegangen.";
  }
}

async function notify(body: string) {
  if (AppState.currentState === "active") return;
  await Notifications.scheduleNotificationAsync({ content: { title: "NOVA", body }, trigger: null }).catch(() => {});
}

export const useCompanion = create<Store>((set, get) => {
  const persist = () => {
    if (saving) clearTimeout(saving);
    saving = setTimeout(() => void saveState(get()), 500);
  };

  const transmit = (message: PhoneMessage): boolean => {
    if (!connection?.open) return false;
    try {
      connection.send(message);
      return true;
    } catch {
      return false;
    }
  };

  const request = (type: "status.get" | "notices.get" | "tasks.list") => transmit({ type, id: newId(), ts: Date.now() });

  const handle = (message: PcMessage) => {
    if (message.type === "device.revoked") {
      void get().forget();
      return;
    }
    set(applyMessage(get(), message));
    persist();
    switch (message.type) {
      case "notices":
        for (const notice of message.items) void notify(noticeTitle(notice.kind));
        if (message.items.length) transmit({ type: "notices.ack", id: newId(), ts: Date.now(), ids: message.items.map((n) => n.id) });
        break;
      case "approval.request":
        void notify(noticeTitle("approval"));
        break;
      case "task.result":
        void notify(noticeTitle(message.ok ? "taskDone" : "taskFailed"));
        request("tasks.list");
        break;
      case "task.event":
        if (message.event.kind === "accepted") request("tasks.list");
        break;
    }
  };

  const scheduleRetry = () => {
    if (retry || !get().pc || AppState.currentState !== "active") return;
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MOST_RETRY_MS);
  };

  const connect = async () => {
    const pc = get().pc;
    if (!pc || connection?.open || connecting) return;
    connecting = true;
    set({ link: "connecting" });
    let opened: Connection | null = null;
    try {
      const id = await identity(pc);
      if (id) {
        try {
          opened = await Connection.open(pc.hosts, id, socketFactory);
        } catch {
          // The PC may have a new address: ask the network.
          const found = await discover(pc.pcId);
          if (found.length) {
            opened = await Connection.open(found, id, socketFactory).catch(() => null);
            if (opened) {
              const hosts = [...new Set([...found, ...pc.hosts])].slice(0, 6);
              await savePc({ ...pc, hosts });
              set({ pc: { ...pc, hosts } });
            }
          }
        }
      }
    } finally {
      connecting = false;
    }
    if (!opened) {
      set({ link: "offline" });
      scheduleRetry();
      return;
    }
    connection = opened;
    retryDelay = 2000;
    opened.onMessage = handle;
    opened.onClose = () => {
      connection = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (get().pc) set({ link: "offline" });
      scheduleRetry();
    };
    set({ link: "online" });
    if (pc.hosts[0] !== opened.host) {
      const hosts = [opened.host, ...pc.hosts.filter((h) => h !== opened.host)];
      void savePc({ ...pc, hosts });
      set({ pc: { ...pc, hosts } });
    }
    request("status.get");
    request("notices.get");
    request("tasks.list");
    for (const task of get().outbox) transmit(task);
    heartbeat = setInterval(() => request("status.get"), HEARTBEAT_MS);
  };

  return {
    ...emptyState,
    ready: false,
    pc: null,
    link: "unpaired",

    async init() {
      if (get().ready) return;
      const [pc, saved] = await Promise.all([loadPc(), loadState()]);
      set({ ...saved, pc, ready: true, link: pc ? "offline" : "unpaired" });
      AppState.addEventListener("change", (now) => {
        if (now === "active") void connect();
      });
      void connect();
    },

    async pair(scanned, deviceName) {
      const code = parsePairingCode(scanned.trim());
      if (!code.ok) throw new Error("Das ist kein Kopplungscode von NOVA.");
      // SECURITY: approvals depend on a fingerprint or face; without one there is nothing to bind them to.
      const [hardware, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]);
      if (!hardware || !enrolled) throw new Error("Richte zuerst Fingerabdruck oder Gesichtserkennung auf deinem Handy ein.");
      const result = await pairWithPc(code.value, deviceName, Platform.OS === "ios" ? "ios" : "android", socketFactory);
      await saveKeys(result.deviceSecret, result.approvalKey);
      const pc: PairedPc = { pcId: code.value.pcId, pcPub: code.value.pcPub, pcName: result.pcName, deviceId: result.deviceId, hosts: [result.host, ...code.value.hosts.filter((h) => h !== result.host)] };
      await savePc(pc);
      set({ ...emptyState, pc, link: "offline" });
      await saveState(get());
      void connect();
    },

    send(text, { schedule, wantScreenshot, voice }) {
      const task: TaskCreate = { type: "task.create", id: newId(), ts: Date.now(), text: text.trim(), voice, wantScreenshot, schedule };
      set(addTask(get(), task));
      persist();
      transmit(task);
      return task.id;
    },

    cancel(taskId) {
      // Not sent yet: just take it back.
      if (get().outbox.some((t) => t.id === taskId)) {
        set(applyMessage(get(), { type: "error", id: newId(), ts: Date.now(), code: "invalid", message: "Abgebrochen", replyTo: taskId }));
        persist();
        return;
      }
      transmit({ type: "task.cancel", id: newId(), ts: Date.now(), taskId });
    },

    async approve(approval) {
      if (!connection?.open) throw new Error("Dein PC ist nicht erreichbar.");
      if (approval.expiresAt <= Date.now()) throw new Error("Diese Freigabe ist abgelaufen.");
      // SECURITY: the key comes out of the Keystore only after the fingerprint or face check.
      const key = await approvalKey();
      if (!key) throw new Error("Freigabe abgebrochen.");
      const sent = transmit({ type: "approval.answer", id: newId(), ts: Date.now(), requestId: approval.requestId, approved: true, proof: approvalProof(key, approval.requestId, approval.expiresAt) });
      if (!sent) throw new Error("Dein PC ist nicht erreichbar.");
    },

    decline(approval) {
      transmit({ type: "approval.answer", id: newId(), ts: Date.now(), requestId: approval.requestId, approved: false });
      set({ approvals: get().approvals.filter((a) => a.requestId !== approval.requestId) });
    },

    refresh() {
      if (connection?.open) {
        request("status.get");
        request("tasks.list");
      } else {
        retryDelay = 2000;
        void connect();
      }
    },

    async forget() {
      connection?.close();
      connection = null;
      if (retry) clearTimeout(retry);
      retry = null;
      await forgetPc();
      set({ ...emptyState, pc: null, link: "unpaired" });
    },
  };
});

