// The app's state and its one connection to the PC: connects while the app is open,
// reconnects with a growing pause, notices a dead line, sends waiting tasks first thing.

import { CompanionError, Connection, type Identity, newId, pairWithPc, type PairResult, type SocketFactory, type SocketLike } from "@nova/companion-protocol/client";
import { approvalProof } from "@nova/companion-protocol/crypto";
import type { ApprovalRequest, PairingCode, PcMessage, PhoneMessage, Schedule, TaskCreate } from "@nova/companion-protocol";
import { parsePairingCode } from "@nova/companion-protocol";
import { addTask, applyMessage, emptyState, noticeTitle } from "@nova/companion-protocol/state";
import { parseHostInput } from "@nova/companion-protocol/app";
import * as LocalAuthentication from "expo-local-authentication";
import { AppState, Platform } from "react-native";
import { create } from "zustand";
import { setAppearance } from "./appearance";
import { discover } from "./discovery";
import { setHapticsEnabled } from "./haptics";
import { clockOffset, dueForwards, errorText, mergeHosts, pruneHidden, queueForward, reconcileChat, rememberApp, retryDelay, taskText, trimScreenshots, type Waiting } from "./logic";
import { notify } from "./notify";
import { applyPhoneSettings, callSnapshot, DEFAULT_PHONE_SETTINGS, handleCallAction, loadPhoneSettings, type PhoneSettings, savePhoneSettings, startPhoneBridge } from "./phone";
import { approvalKey, forgetPc, identity, loadPc, loadState, type PairedPc, savePc, type SavedState, saveKeys, saveState } from "./storage";
import { toast } from "./toast";
import { useUpdates } from "./updates";

export type Link = "unpaired" | "connecting" | "online" | "offline";

interface Store extends SavedState {
  ready: boolean;
  pc: PairedPc | null;
  link: Link;
  settings: PhoneSettings;
  /** How long the PC took to answer the last status request, in ms. */
  latency: number | null;
  /** The PC's clock minus this phone's. Approvals expire by the PC's clock. */
  clockOffset: number;
  /** When the next attempt to reach the PC starts, while it is unreachable. */
  retryAt: number | null;
  /** The PC accepted a pairing whose keys still wait for the fingerprint (`finishPairing`). */
  pairingPending: boolean;
  init(): Promise<void>;
  setSettings(patch: Partial<PhoneSettings>): Promise<void>;
  /** Adds a PC address typed by hand; `false` if it isn't a local network address. */
  addHost(text: string): Promise<boolean>;
  removeHost(host: string): Promise<void>;
  /** `extraHost` is an address typed by hand, tried beside the ones in the code. */
  pair(scanned: string, deviceName: string, extraHost?: string): Promise<void>;
  /** Stores the keys of the pairing the PC accepted. Throws again if the fingerprint was cancelled again. */
  finishPairing(): Promise<void>;
  send(text: string, options: { schedule: Schedule; wantScreenshot: boolean; voice: boolean }): string;
  /** `false` if the PC couldn't be told. */
  cancel(taskId: string): boolean;
  /** Resolves once the PC confirmed the approval. */
  approve(request: ApprovalRequest): Promise<void>;
  /** `false` if the PC couldn't be told; it then keeps waiting until the approval expires. */
  decline(request: ApprovalRequest): boolean;
  /** Asks the PC for its state again, or tries to reach it; resolves when it answered or after a moment. */
  refresh(): Promise<void>;
  /** For the background task: reach the PC, hand over what waits, listen for `listenMs`, save. */
  sync(listenMs: number): Promise<void>;
  hideTask(taskId: string): void;
  unhideTask(taskId: string): void;
  forget(): Promise<void>;
}

const socketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

const HEARTBEAT_MS = 30_000;
/** The PC answers a status request at once; silence for this long means the line is dead. */
const REPLY_MS = 10_000;
const APPROVAL_REPLY_MS = 8000;
const REFRESH_MS = 2500;
/** Screenshots kept in memory, newest first; each is up to 4 MB. */
const KEEP_SCREENSHOTS = 4;

let connection: Connection | null = null;
let connecting: Promise<void> | null = null;
let starting: Promise<void> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let replyTimer: ReturnType<typeof setTimeout> | null = null;
/** When the status request went out that still waits for its answer; 0 if none does. */
let asked = 0;
/** Whether the PC said anything since that request went out. */
let answered = false;
let saving: ReturnType<typeof setTimeout> | null = null;
let waiting: Waiting[] = [];
let pendingPair: { code: PairingCode; result: PairResult } | null = null;
/** Approval answers the PC hasn't confirmed yet, by message id. */
const answers = new Map<string, { requestId: string; settle: (error: Error | null) => void }>();
/** Approvals the user was already told about; the PC repeats open ones on every connect. */
const announced = new Set<string>();
let refreshing: (() => void)[] = [];

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
      return "Dein PC ist nicht erreichbar. Handy und PC müssen im selben Netz sein (WLAN oder LAN-Kabel am selben Router) oder per USB-Tethering verbunden. Am PC hilft „Check network“ auf der Seite „Phone“.";
    case "timeout":
      return "Dein PC hat nicht rechtzeitig geantwortet.";
    case "invalid":
    case "rejected":
      return "Das hat nicht geklappt. Versuch es mit einem neuen Code.";
    default:
      return error instanceof Error && error.message ? error.message : "Etwas ist schiefgegangen.";
  }
}

/**
 * Every address at once; the first finished handshake wins and the others are closed.
 * One after the other would cost four seconds for each address that no longer answers.
 */
function openFirst(hosts: string[], id: Identity): Promise<Connection | null> {
  if (!hosts.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let left = hosts.length;
    let won = false;
    for (const host of hosts) {
      Connection.open([host], id, socketFactory)
        .then(
          (opened) => {
            if (won) opened.close();
            else {
              won = true;
              resolve(opened);
            }
          },
          () => {},
        )
        .finally(() => {
          left -= 1;
          if (left === 0 && !won) resolve(null);
        });
    }
  });
}

export const useCompanion = create<Store>((set, get) => {
  const saved = (): SavedState => {
    const { status, chat, approvals, tasks, outbox, hiddenTasks } = get();
    return { status, chat, approvals, tasks, outbox, hiddenTasks };
  };

  const persist = () => {
    if (saving) clearTimeout(saving);
    saving = setTimeout(() => {
      saving = null;
      void saveState(saved());
    }, 500);
  };

  /** Saves now: the app is leaving the screen and may not come back. */
  const flush = async () => {
    if (saving) clearTimeout(saving);
    saving = null;
    await saveState(saved());
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

  const request = (type: "notices.get" | "tasks.list") => transmit({ type, id: newId(), ts: Date.now() });

  /** Asks for the PC's status and makes sure it answers. */
  const probe = () => {
    if (!transmit({ type: "status.get", id: newId(), ts: Date.now() })) return;
    // An earlier question still waits: its timer decides.
    if (asked) return;
    asked = Date.now();
    answered = false;
    replyTimer = setTimeout(() => {
      replyTimer = null;
      asked = 0;
      // The PC sleeps or the network is gone, and nothing closed the socket. Without
      // this the app would say "Verbunden" until Android gives up, minutes later.
      if (!answered) connection?.close();
    }, REPLY_MS);
  };

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    if (replyTimer) clearTimeout(replyTimer);
    heartbeat = null;
    replyTimer = null;
    asked = 0;
  };

  const settleAnswer = (requestId: string, error: Error | null) => {
    for (const [id, answer] of answers) {
      if (answer.requestId !== requestId) continue;
      answers.delete(id);
      answer.settle(error);
    }
  };

  const handle = (message: PcMessage) => {
    const now = Date.now();
    // Anything the PC says proves the line is alive, not only the answer to the question.
    answered = true;
    if (message.type === "device.revoked") {
      void get().forget();
      return;
    }
    if (message.type === "call.action") {
      void handleCallAction(message);
      return;
    }
    // The PC speaks English; the chat shows its refusals in the app's words.
    const shown = message.type === "error" ? { ...message, message: errorText(message.code, message.message) } : message;
    let next: Partial<Store> = applyMessage(get(), shown);
    switch (message.type) {
      case "status": {
        if (asked) {
          next.latency = now - asked;
          asked = 0;
          if (replyTimer) clearTimeout(replyTimer);
          replyTimer = null;
        }
        next.clockOffset = clockOffset(get().clockOffset, message.ts, now);
        const pc = get().pc;
        if (pc && pc.pcName !== message.pcName) {
          next.pc = { ...pc, pcName: message.pcName };
          void savePc(next.pc);
        }
        for (const done of refreshing) done();
        refreshing = [];
        break;
      }
      case "notices":
        for (const notice of message.items) void notify(noticeTitle(notice.kind), "chat");
        if (message.items.length) transmit({ type: "notices.ack", id: newId(), ts: now, ids: message.items.map((n) => n.id) });
        break;
      case "approval.request":
        if (!announced.has(message.requestId)) {
          announced.add(message.requestId);
          void notify(noticeTitle("approval"), "approvals");
        }
        break;
      case "approval.closed":
        announced.delete(message.requestId);
        settleAnswer(message.requestId, message.outcome === "approved" ? null : new Error(message.outcome === "expired" ? "Diese Freigabe ist abgelaufen." : "Diese Freigabe wurde am PC beendet."));
        break;
      case "tasks":
        next = { ...next, chat: reconcileChat(next.chat ?? get().chat, message.items), hiddenTasks: pruneHidden(get().hiddenTasks, message.items, next.outbox ?? get().outbox) };
        break;
      case "task.result":
        next = { ...next, chat: trimScreenshots(next.chat ?? get().chat, KEEP_SCREENSHOTS) };
        void notify(noticeTitle(message.ok ? "taskDone" : "taskFailed"), "chat");
        request("tasks.list");
        break;
      case "task.event":
        if (message.event.kind === "accepted") request("tasks.list");
        break;
      case "error": {
        const answer = message.replyTo ? answers.get(message.replyTo) : undefined;
        if (answer && message.replyTo) {
          // The PC refused an approval answer: the approval is gone there, so it goes here too.
          answers.delete(message.replyTo);
          next = { ...next, approvals: get().approvals.filter((a) => a.requestId !== answer.requestId) };
          answer.settle(new Error(errorText(message.code, message.message)));
        } else if (!message.replyTo || !get().outbox.some((task) => task.id === message.replyTo)) {
          // Not about a task in the chat (those show it there): say it once.
          if (message.code !== "invalid" || message.replyTo) toast(errorText(message.code, ""), { tone: "warning" });
        }
        break;
      }
    }
    set(next);
    persist();
  };

  const scheduleRetry = () => {
    if (retry || !get().pc || AppState.currentState !== "active") return;
    const delay = retryDelay(failures);
    failures += 1;
    set({ retryAt: Date.now() + delay });
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, delay);
  };

  const attempt = async (pc: PairedPc): Promise<void> => {
    if (retry) clearTimeout(retry);
    retry = null;
    set({ link: "connecting", retryAt: null });
    let opened: Connection | null = null;
    let found: string[] = [];
    try {
      const id = await identity(pc);
      if (id) {
        opened = await openFirst(pc.hosts, id);
        if (!opened) {
          // The PC may have a new address: ask the network.
          found = (await discover(pc.pcId).catch(() => [])).filter((host) => !pc.hosts.includes(host));
          opened = await openFirst(found, id);
        }
      }
    } catch {
      opened = null;
    }
    // Forgotten or paired anew while this ran: the session belongs to no one.
    const current = get().pc;
    if (!current || current.deviceId !== pc.deviceId) {
      opened?.close();
      return;
    }
    if (!opened?.open) {
      set({ link: "offline" });
      scheduleRetry();
      return;
    }
    const session = opened;
    connection = session;
    failures = 0;
    session.onMessage = handle;
    session.onClose = () => {
      if (connection !== session) return;
      connection = null;
      stopHeartbeat();
      for (const [id, answer] of answers) {
        answers.delete(id);
        answer.settle(new Error("Dein PC ist nicht erreichbar."));
      }
      // What the PC said about itself is no longer true: no stale "läuft" on the start screen.
      if (get().pc) set({ link: "offline", status: null, latency: null });
      scheduleRetry();
    };
    // The PC sends every open approval again right after the first message; the ones it
    // doesn't send were closed while the phone was away.
    set({ link: "online", retryAt: null, approvals: [] });
    // Addresses are merged into the pairing as it is now, not as it was when this attempt
    // started: one added by hand meanwhile must survive.
    const hosts = mergeHosts([session.host], [...found, ...current.hosts]);
    if (hosts.join() !== current.hosts.join()) {
      const merged = { ...current, hosts };
      set({ pc: merged });
      void savePc(merged);
    }
    probe();
    request("notices.get");
    request("tasks.list");
    for (const task of get().outbox) transmit(task);
    for (const message of [...callSnapshot(), ...dueForwards(waiting, Date.now())]) transmit(message);
    waiting = [];
    heartbeat = setInterval(probe, HEARTBEAT_MS);
  };

  function connect(): Promise<void> {
    if (connecting) return connecting;
    const pc = get().pc;
    if (!pc || connection?.open) return Promise.resolve();
    connecting = attempt(pc).finally(() => {
      connecting = null;
      // Paired with another PC while that attempt ran: it was for the old one.
      const now = get().pc;
      if (now && now.deviceId !== pc.deviceId) void connect();
    });
    return connecting;
  }

  /** A notification or call for Nova Island: now, or as soon as the PC answers. */
  const forward = (message: PhoneMessage) => {
    if (!get().pc) return;
    if (transmit(message)) return;
    waiting = queueForward(waiting, message, Date.now());
    // Also in the background: a ringing call can't wait for the app to open.
    void connect();
  };

  const sawApp = (app: string, name: string) => {
    const seenApps = rememberApp(get().settings.seenApps, app, name);
    if (seenApps !== get().settings.seenApps) void get().setSettings({ seenApps });
  };

  const applySettings = (settings: PhoneSettings) => {
    applyPhoneSettings(settings);
    setAppearance(settings.appearance);
    setHapticsEnabled(settings.haptics);
  };

  const savePcHosts = async (hosts: string[]) => {
    const pc = get().pc;
    if (!pc) return;
    const next = { ...pc, hosts: mergeHosts(hosts, []) };
    set({ pc: next });
    await savePc(next);
  };

  return {
    ...emptyState,
    hiddenTasks: [],
    ready: false,
    pc: null,
    link: "unpaired",
    settings: DEFAULT_PHONE_SETTINGS,
    latency: null,
    clockOffset: 0,
    retryAt: null,
    pairingPending: false,

    init() {
      starting ??= (async () => {
        const [pc, state, settings] = await Promise.all([loadPc(), loadState(), loadPhoneSettings()]);
        set({ ...state, pc, settings, ready: true, link: pc ? "offline" : "unpaired" });
        applySettings(settings);
        startPhoneBridge(forward, sawApp);
        AppState.addEventListener("change", (now) => {
          if (now !== "active") {
            void flush();
            return;
          }
          // Back in front: don't sit out a pause that grew while the PC was off.
          failures = 0;
          if (connection?.open) probe();
          else void connect();
        });
        void connect();
        if (settings.checkUpdates && AppState.currentState === "active") void useUpdates.getState().check();
      })();
      return starting;
    },

    async setSettings(patch) {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      applySettings(settings);
      await savePhoneSettings(settings);
    },

    async addHost(text) {
      const host = parseHostInput(text);
      const pc = get().pc;
      if (!host || !pc) return false;
      // Tried with the others next time; the one that answers moves up front by itself.
      await savePcHosts([host, ...pc.hosts]);
      failures = 0;
      if (!connecting) void connect();
      return true;
    },

    async removeHost(host) {
      const pc = get().pc;
      if (!pc || pc.hosts.length <= 1) return;
      await savePcHosts(pc.hosts.filter((h) => h !== host));
    },

    async pair(scanned, deviceName, extraHost) {
      const parsed = parsePairingCode(scanned.trim());
      if (!parsed.ok) throw new Error("Das ist kein Kopplungscode von NOVA.");
      // SECURITY: approvals depend on a fingerprint or face; without one there is nothing to bind them to.
      const [hardware, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]);
      if (!hardware || !enrolled) throw new Error("Richte zuerst Fingerabdruck oder Gesichtserkennung auf deinem Handy ein.");
      const manual = extraHost ? parseHostInput(extraHost) : null;
      const code: PairingCode = { ...parsed.value, hosts: mergeHosts(parsed.value.hosts, manual ? [manual] : []) };
      const platform = Platform.OS === "ios" ? "ios" : "android";
      // The PC decides whether the code is still good. This phone's clock may run ahead of
      // the PC's, and the code would look expired here while the PC still takes it.
      const now = Math.min(Date.now(), code.expiresAt);
      let result: PairResult;
      try {
        result = await pairWithPc(code, deviceName, platform, socketFactory, now);
      } catch (error) {
        if (!(error instanceof CompanionError) || error.reason !== "unreachable") throw error;
        // None of the code's addresses answered: ask the network where this PC is.
        const found = (await discover(code.pcId).catch(() => [])).filter((host) => !code.hosts.includes(host));
        if (!found.length) throw error;
        result = await pairWithPc({ ...code, hosts: found }, deviceName, platform, socketFactory, now);
      }
      pendingPair = { code, result };
      await get().finishPairing();
    },

    async finishPairing() {
      const pending = pendingPair;
      if (!pending) return;
      const { code, result } = pending;
      try {
        await saveKeys(result.deviceSecret, result.approvalKey);
      } catch {
        // The PC already knows this phone. Keeping the result lets the user try the
        // fingerprint again instead of pairing a second time.
        set({ pairingPending: true });
        throw new Error("Ohne deinen Fingerabdruck kann die App den Schlüssel für Freigaben nicht sichern. Versuch es noch einmal.");
      }
      const pc: PairedPc = { pcId: code.pcId, pcPub: code.pcPub, pcName: result.pcName, deviceId: result.deviceId, hosts: mergeHosts([result.host], code.hosts) };
      await savePc(pc);
      pendingPair = null;
      // A session with a PC paired before ends here.
      connection?.close();
      announced.clear();
      waiting = [];
      set({ ...emptyState, hiddenTasks: [], pc, link: "offline", pairingPending: false, latency: null, retryAt: null });
      await saveState(saved());
      failures = 0;
      void connect();
    },

    send(text, { schedule, wantScreenshot, voice }) {
      const task: TaskCreate = { type: "task.create", id: newId(), ts: Date.now(), text: taskText(text), voice, wantScreenshot, schedule };
      set(addTask(get(), task));
      persist();
      transmit(task);
      return task.id;
    },

    cancel(taskId) {
      // Not sent yet: just take it back.
      if (get().outbox.some((task) => task.id === taskId)) {
        set({ outbox: get().outbox.filter((task) => task.id !== taskId), chat: get().chat.map((entry) => (entry.taskId === taskId ? { ...entry, state: "cancelled", activity: null } : entry)) });
        persist();
        return true;
      }
      return transmit({ type: "task.cancel", id: newId(), ts: Date.now(), taskId });
    },

    async approve(approval) {
      if (!connection?.open) throw new Error("Dein PC ist nicht erreichbar.");
      if (approval.expiresAt <= Date.now() + get().clockOffset) throw new Error("Diese Freigabe ist abgelaufen.");
      // SECURITY: the key comes out of the Keystore only after the fingerprint or face check.
      const result = await approvalKey();
      if ("missing" in result) {
        throw new Error(
          result.missing === "lost"
            ? "Der Schlüssel für Freigaben ist nicht mehr gültig, zum Beispiel weil sich die Fingerabdrücke auf deinem Handy geändert haben. Kopple dein Handy neu."
            : "Freigabe abgebrochen.",
        );
      }
      const id = newId();
      const confirmed = new Promise<Error | null>((resolve) => {
        const timer = setTimeout(() => {
          answers.delete(id);
          resolve(new Error("Dein PC hat die Freigabe nicht bestätigt."));
        }, APPROVAL_REPLY_MS);
        answers.set(id, {
          requestId: approval.requestId,
          settle: (error) => {
            clearTimeout(timer);
            resolve(error);
          },
        });
      });
      const sent = transmit({ type: "approval.answer", id, ts: Date.now(), requestId: approval.requestId, approved: true, proof: approvalProof(result.key, approval.requestId, approval.expiresAt) });
      if (!sent) {
        answers.get(id)?.settle(new Error("Dein PC ist nicht erreichbar."));
        answers.delete(id);
      }
      const error = await confirmed;
      if (error) throw error;
    },

    decline(approval) {
      if (!transmit({ type: "approval.answer", id: newId(), ts: Date.now(), requestId: approval.requestId, approved: false })) return false;
      set({ approvals: get().approvals.filter((a) => a.requestId !== approval.requestId) });
      return true;
    },

    refresh() {
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, REFRESH_MS);
        refreshing.push(() => {
          clearTimeout(timer);
          resolve();
        });
        if (connection?.open) {
          probe();
          request("tasks.list");
        } else {
          failures = 0;
          void connect();
        }
      });
    },

    async sync(listenMs) {
      await get().init();
      await connect();
      if (!connection?.open) return;
      await new Promise((resolve) => setTimeout(resolve, listenMs));
      await flush();
    },

    hideTask(taskId) {
      if (get().hiddenTasks.includes(taskId)) return;
      set({ hiddenTasks: [...get().hiddenTasks, taskId] });
      persist();
    },

    unhideTask(taskId) {
      set({ hiddenTasks: get().hiddenTasks.filter((id) => id !== taskId) });
      persist();
    },

    async forget() {
      const session = connection;
      connection = null;
      session?.close();
      stopHeartbeat();
      if (retry) clearTimeout(retry);
      retry = null;
      pendingPair = null;
      waiting = [];
      announced.clear();
      await forgetPc();
      set({ ...emptyState, hiddenTasks: [], pc: null, link: "unpaired", latency: null, retryAt: null, pairingPending: false });
    },
  };
});
