// The store and its connection against stand-ins: a fake session in place of the
// socket and the encryption (those have their own tests in packages/companion-protocol),
// and empty shells for what only exists on a phone.

import type { ApprovalRequest, PcMessage, PhoneMessage, Status, TaskSummary } from "@nova/companion-protocol";
import { encodePairingCode } from "@nova/companion-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairedPc } from "./storage";

const world = vi.hoisted(() => {
  class FakeConnection {
    sent: PhoneMessage[] = [];
    closed = false;
    onMessage: (message: PcMessage) => void = () => {};
    onClose: () => void = () => {};
    constructor(readonly host: string) {}
    get open() {
      return !this.closed;
    }
    send(message: PhoneMessage) {
      if (this.closed) throw new Error("closed");
      this.sent.push(message);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.onClose();
    }
    /** The PC says something. */
    receive(message: PcMessage) {
      this.onMessage(message);
    }
    types() {
      return this.sent.map((message) => message.type);
    }
  }
  return {
    FakeConnection,
    /** Every session that was opened, oldest first. */
    sessions: [] as InstanceType<typeof FakeConnection>[],
    /** Addresses that answer. */
    reachable: new Set<string>(),
    /** Set to hold every connection attempt until `release()` is called. */
    gate: null as Promise<void> | null,
    appState: { currentState: "active" as "active" | "background", listeners: [] as ((state: string) => void)[] },
    pc: null as PairedPc | null,
    approvalKey: { key: new Uint8Array(32) } as { key: Uint8Array } | { missing: "cancelled" | "lost" },
    saveKeysFails: false,
    forward: null as ((message: PhoneMessage) => void) | null,
    snapshot: [] as PhoneMessage[],
    found: [] as string[],
  };
});

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return world.appState.currentState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      world.appState.listeners.push(listener);
      return { remove() {} };
    },
  },
  Platform: { OS: "android" },
}));

vi.mock("expo-local-authentication", () => ({ hasHardwareAsync: async () => true, isEnrolledAsync: async () => true }));
vi.mock("./notify", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("./haptics", () => ({ setHapticsEnabled: vi.fn() }));
vi.mock("./updates", () => ({ useUpdates: { getState: () => ({ check: vi.fn(async () => {}) }) } }));
vi.mock("./discovery", () => ({ discover: vi.fn(async () => world.found) }));

vi.mock("./phone", () => ({
  DEFAULT_PHONE_SETTINGS: { notifications: false, calls: false, onlyAppNames: false, skipSilent: true, mutedApps: [], seenApps: [], checkUpdates: false, appearance: "system", haptics: true },
  applyPhoneSettings: vi.fn(),
  callSnapshot: () => world.snapshot,
  handleCallAction: vi.fn(async () => true),
  loadPhoneSettings: async () => ({ notifications: false, calls: false, onlyAppNames: false, skipSilent: true, mutedApps: [], seenApps: [], checkUpdates: false, appearance: "system", haptics: true }),
  savePhoneSettings: vi.fn(async () => {}),
  startPhoneBridge: (forward: (message: PhoneMessage) => void) => {
    world.forward = forward;
    return () => {};
  },
}));

vi.mock("./storage", () => ({
  approvalKey: async () => world.approvalKey,
  forgetPc: vi.fn(async () => {
    world.pc = null;
  }),
  identity: async (pc: PairedPc) => ({ pcId: pc.pcId, pcPub: new Uint8Array(32), deviceId: pc.deviceId, deviceSecret: new Uint8Array(32) }),
  loadPc: async () => world.pc,
  loadState: async () => ({ status: null, chat: [], approvals: [], tasks: [], outbox: [], hiddenTasks: [] }),
  savePc: vi.fn(async (pc: PairedPc) => {
    world.pc = pc;
  }),
  saveKeys: vi.fn(async () => {
    if (world.saveKeysFails) throw new Error("User canceled the authentication");
  }),
  saveState: vi.fn(async () => {}),
}));

vi.mock("@nova/companion-protocol/client", async (original) => {
  const real = await original<typeof import("@nova/companion-protocol/client")>();
  const open = async (hosts: string[]) => {
    if (world.gate) await world.gate;
    const host = hosts.find((each) => world.reachable.has(each));
    if (!host) throw new real.CompanionError("unreachable");
    const session = new world.FakeConnection(host);
    world.sessions.push(session);
    return session;
  };
  return {
    ...real,
    Connection: { open },
    pairWithPc: vi.fn(async (code: { hosts: string[] }, _name: string, _platform: string, _factory: unknown, now: number) => {
      if (now > (code as unknown as { expiresAt: number }).expiresAt) throw new real.CompanionError("expired");
      const host = code.hosts.find((each) => world.reachable.has(each));
      if (!host) throw new real.CompanionError("unreachable");
      return { deviceId: "device-2", pcName: "Neuer PC", host, deviceSecret: new Uint8Array(32), approvalKey: new Uint8Array(32) };
    }),
  };
});

const PC: PairedPc = { pcId: "pc-1", pcPub: "A".repeat(43), pcName: "Gaming-PC", deviceId: "device-1", hosts: ["192.168.1.5:47621"] };

const status = (more: Partial<Status> = {}): Status => ({ type: "status", id: "s", ts: Date.now(), pcName: "Gaming-PC", busy: false, aiReady: true, inGame: false, media: null, pendingApprovals: 0, activeTasks: 0, ...more });

const approval = (requestId: string, expiresAt = Date.now() + 120_000): ApprovalRequest => ({ type: "approval.request", id: `m-${requestId}`, ts: Date.now(), requestId, taskId: "t1", title: "Steam beenden", detail: null, risk: "high", expiresAt });

async function start() {
  const { useCompanion } = await import("./store");
  await useCompanion.getState().init();
  await vi.advanceTimersByTimeAsync(0);
  return useCompanion;
}

const latest = () => world.sessions[world.sessions.length - 1]!;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 11, 12, 0));
  world.sessions.length = 0;
  world.reachable.clear();
  world.reachable.add("192.168.1.5:47621");
  world.gate = null;
  world.appState.currentState = "active";
  world.appState.listeners.length = 0;
  world.pc = { ...PC, hosts: [...PC.hosts] };
  world.approvalKey = { key: new Uint8Array(32) };
  world.saveKeysFails = false;
  world.forward = null;
  world.snapshot = [];
  world.found = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connecting", () => {
  it("asks for the status first, then for notices and tasks, then sends what waits", async () => {
    const store = await start();
    expect(store.getState().link).toBe("online");
    expect(latest().types()).toEqual(["status.get", "notices.get", "tasks.list"]);
  });

  it("sends tasks from the outbox as soon as the PC answers", async () => {
    world.reachable.clear();
    const store = await start();
    expect(store.getState().link).toBe("offline");
    const id = store.getState().send("Öffne Spotify", { schedule: { kind: "now" }, wantScreenshot: false, voice: false });
    expect(store.getState().outbox).toHaveLength(1);

    world.reachable.add("192.168.1.5:47621");
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getState().link).toBe("online");
    expect(latest().sent.find((message) => message.type === "task.create")).toMatchObject({ id, text: "Öffne Spotify" });
  });

  it("tries every known address at once and remembers the one that answered", async () => {
    world.pc = { ...PC, hosts: ["10.0.0.1:47621", "10.0.0.2:47621", "192.168.1.5:47621"] };
    const store = await start();
    expect(store.getState().link).toBe("online");
    expect(store.getState().pc?.hosts[0]).toBe("192.168.1.5:47621");
    expect(store.getState().pc?.hosts).toHaveLength(3);
  });

  it("finds a PC whose address changed through the network", async () => {
    world.reachable.clear();
    world.reachable.add("192.168.1.77:47621");
    world.found = ["192.168.1.77:47621"];
    const store = await start();
    expect(store.getState().link).toBe("online");
    expect(store.getState().pc?.hosts).toEqual(["192.168.1.77:47621", "192.168.1.5:47621"]);
  });

  it("waits longer after each failure and says when it tries again", async () => {
    world.reachable.clear();
    const store = await start();
    expect(store.getState().retryAt).toBe(Date.now() + 2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getState().retryAt).toBe(Date.now() + 4000);
  });

  it("starts over at once when the app comes back to the front", async () => {
    world.reachable.clear();
    const store = await start();
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);
    expect(store.getState().link).toBe("offline");

    world.reachable.add("192.168.1.5:47621");
    for (const listener of world.appState.listeners) listener("active");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().link).toBe("online");
  });
});

describe("a line that went dead", () => {
  it("closes when the PC doesn't answer a status request", async () => {
    const store = await start();
    latest().receive(status({ media: { title: "Song", artist: "Band", playing: true } }));
    expect(store.getState().status?.media?.playing).toBe(true);

    // The heartbeat asks again after 30 s; the PC sleeps and says nothing.
    await vi.advanceTimersByTimeAsync(30_000 + 10_000);
    expect(world.sessions[0]!.closed).toBe(true);
    expect(store.getState().link).not.toBe("online");
    // What the PC said about itself is no longer shown as true.
    expect(store.getState().status).toBeNull();
    expect(store.getState().latency).toBeNull();
  });

  it("stays open while the PC answers, and measures how long it took", async () => {
    const store = await start();
    await vi.advanceTimersByTimeAsync(40);
    latest().receive(status());
    expect(store.getState().latency).toBe(40);

    // The next heartbeat goes out 30 s after the connection opened.
    await vi.advanceTimersByTimeAsync(30_000 - 40);
    await vi.advanceTimersByTimeAsync(25);
    latest().receive(status());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(latest().closed).toBe(false);
    expect(store.getState().link).toBe("online");
    expect(store.getState().latency).toBe(25);
  });

  it("checks the line when the app comes back to the front", async () => {
    const store = await start();
    latest().receive(status());
    for (const listener of world.appState.listeners) listener("active");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.sessions[0]!.closed).toBe(true);
    expect(store.getState().link).not.toBe("online");
  });
});

describe("races with pairing", () => {
  it("drops a session that finished after the pairing was forgotten", async () => {
    let release = () => {};
    world.gate = new Promise((resolve) => (release = resolve));
    const { useCompanion } = await import("./store");
    await useCompanion.getState().init();
    expect(useCompanion.getState().link).toBe("connecting");

    await useCompanion.getState().forget();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(useCompanion.getState().link).toBe("unpaired");
    expect(useCompanion.getState().pc).toBeNull();
    expect(world.sessions.every((session) => session.closed)).toBe(true);
  });

  it("keeps an address added by hand while a connection attempt was running", async () => {
    world.pc = { ...PC, hosts: ["10.0.0.9:47621", "192.168.1.5:47621"] };
    let release = () => {};
    world.gate = new Promise((resolve) => (release = resolve));
    const { useCompanion } = await import("./store");
    await useCompanion.getState().init();

    expect(await useCompanion.getState().addHost("192.168.178.98")).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(useCompanion.getState().link).toBe("online");
    expect(useCompanion.getState().pc?.hosts).toEqual(["192.168.1.5:47621", "192.168.178.98:47621", "10.0.0.9:47621"]);
  });

  it("refuses an address outside the home network", async () => {
    const store = await start();
    expect(await store.getState().addHost("8.8.8.8")).toBe(false);
    expect(store.getState().pc?.hosts).toEqual(["192.168.1.5:47621"]);
  });
});

describe("approvals", () => {
  it("forgets approvals the PC doesn't repeat after a reconnect, and announces each one once", async () => {
    world.appState.currentState = "background";
    const store = await start();
    const { notify } = await import("./notify");
    latest().receive(approval("r1"));
    latest().receive(approval("r2"));
    expect(store.getState().approvals.map((a) => a.requestId)).toEqual(["r1", "r2"]);

    latest().close();
    world.appState.currentState = "active";
    for (const listener of world.appState.listeners) listener("active");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().approvals).toEqual([]);

    // The PC sends what is still open; r2 was closed while the phone was away.
    latest().receive(approval("r1"));
    expect(store.getState().approvals.map((a) => a.requestId)).toEqual(["r1"]);
    expect(vi.mocked(notify).mock.calls.filter(([body]) => body === "Neue Freigabe")).toHaveLength(2);
  });

  it("resolves an approval once the PC confirmed it", async () => {
    const store = await start();
    const request = approval("r1");
    latest().receive(request);
    const done = store.getState().approve(request);
    await vi.advanceTimersByTimeAsync(0);
    const answer = latest().sent.find((message) => message.type === "approval.answer");
    expect(answer).toMatchObject({ requestId: "r1", approved: true });
    expect(answer && "proof" in answer && answer.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);

    latest().receive({ type: "approval.closed", id: "c", ts: Date.now(), requestId: "r1", outcome: "approved" });
    await expect(done).resolves.toBeUndefined();
    expect(store.getState().approvals).toEqual([]);
  });

  it("shows the PC's refusal in the app's words and removes the approval", async () => {
    const store = await start();
    const request = approval("r1");
    latest().receive(request);
    const done = store.getState().approve(request);
    const failed = expect(done).rejects.toThrow("Diese Freigabe ist nicht mehr offen.");
    await vi.advanceTimersByTimeAsync(0);
    const answer = latest().sent.find((message) => message.type === "approval.answer")!;
    latest().receive({ type: "error", id: "e", ts: Date.now(), code: "unknownRequest", message: "That approval is no longer waiting", replyTo: answer.id });
    await failed;
    expect(store.getState().approvals).toEqual([]);
  });

  it("says so when the PC never confirms", async () => {
    const store = await start();
    const request = approval("r1");
    latest().receive(request);
    const failed = expect(store.getState().approve(request)).rejects.toThrow("Dein PC hat die Freigabe nicht bestätigt.");
    await vi.advanceTimersByTimeAsync(8000);
    await failed;
  });

  it("tells a cancelled fingerprint from a key Android threw away", async () => {
    const store = await start();
    const request = approval("r1");
    latest().receive(request);
    world.approvalKey = { missing: "cancelled" };
    await expect(store.getState().approve(request)).rejects.toThrow("Freigabe abgebrochen.");
    world.approvalKey = { missing: "lost" };
    await expect(store.getState().approve(request)).rejects.toThrow(/Kopple dein Handy neu/);
    expect(latest().sent.some((message) => message.type === "approval.answer")).toBe(false);
  });

  it("judges expiry by the PC's clock", async () => {
    const store = await start();
    // The PC's clock is three minutes behind the phone's.
    latest().receive(status({ ts: Date.now() - 180_000 }));
    expect(store.getState().clockOffset).toBe(-180_000);
    const request = approval("r1", Date.now() - 180_000 + 120_000);
    latest().receive(request);
    const done = store.getState().approve(request);
    await vi.advanceTimersByTimeAsync(0);
    latest().receive({ type: "approval.closed", id: "c", ts: Date.now(), requestId: "r1", outcome: "approved" });
    await expect(done).resolves.toBeUndefined();
  });

  it("keeps an approval that couldn't be declined", async () => {
    const store = await start();
    const request = approval("r1");
    latest().receive(request);
    latest().closed = true;
    expect(store.getState().decline(request)).toBe(false);
    expect(store.getState().approvals).toHaveLength(1);
  });
});

describe("tasks and chat", () => {
  it("takes back a task that never left the phone, and reports when the PC can't be told", async () => {
    world.reachable.clear();
    const store = await start();
    const id = store.getState().send("Später", { schedule: { kind: "whenOnline" }, wantScreenshot: false, voice: false });
    expect(store.getState().cancel(id)).toBe(true);
    expect(store.getState().outbox).toEqual([]);
    expect(store.getState().chat.every((entry) => entry.state === "cancelled")).toBe(true);
    expect(store.getState().cancel("on-the-pc")).toBe(false);
  });

  it("ends a chat entry whose result was lost, from the PC's task list", async () => {
    const store = await start();
    const id = store.getState().send("Wie geht es meinem PC?", { schedule: { kind: "now" }, wantScreenshot: false, voice: false });
    latest().receive({ type: "task.event", id: "e1", ts: Date.now(), taskId: id, event: { kind: "accepted", state: "running" } });
    expect(store.getState().chat[1]!.state).toBe("running");

    const tasks: TaskSummary[] = [{ taskId: id, text: "Wie geht es meinem PC?", state: "done", runAt: null, createdAt: Date.now() }];
    latest().receive({ type: "tasks", id: "t", ts: Date.now(), items: tasks });
    expect(store.getState().chat.map((entry) => entry.state)).toEqual(["done", "done"]);
  });

  it("puts a refused task into the chat in German", async () => {
    world.reachable.clear();
    const store = await start();
    const id = store.getState().send("Noch einer", { schedule: { kind: "now" }, wantScreenshot: false, voice: false });
    world.reachable.add("192.168.1.5:47621");
    await vi.advanceTimersByTimeAsync(2000);
    latest().receive({ type: "error", id: "e", ts: Date.now(), code: "busy", message: "Too many tasks are waiting", replyTo: id });
    expect(store.getState().outbox).toEqual([]);
    expect(store.getState().chat[1]).toMatchObject({ state: "failed", error: "Am PC warten schon zu viele Aufträge." });
  });

  it("cuts an over-long task instead of letting the PC refuse it forever", async () => {
    const store = await start();
    store.getState().send("x".repeat(6000), { schedule: { kind: "now" }, wantScreenshot: false, voice: false });
    expect(store.getState().outbox[0]!.text).toHaveLength(4000);
  });

  it("hides and unhides finished tasks on this phone only", async () => {
    const store = await start();
    store.getState().hideTask("t1");
    store.getState().hideTask("t1");
    expect(store.getState().hiddenTasks).toEqual(["t1"]);
    store.getState().unhideTask("t1");
    expect(store.getState().hiddenTasks).toEqual([]);
    expect(latest().sent.some((message) => message.type === "task.cancel")).toBe(false);
  });
});

describe("Nova Island", () => {
  const ringing: PhoneMessage = { type: "phone.call", id: "c", ts: 0, callId: "call-1", state: "ringing", name: "Mama", number: null, photo: null, canAnswer: true, canDecline: true };

  it("sends the calls in progress after every connect", async () => {
    world.snapshot = [ringing];
    await start();
    expect(latest().sent).toContainEqual(ringing);
  });

  it("delivers the end of a call however long the PC was away", async () => {
    world.reachable.clear();
    await start();
    world.forward!({ ...ringing, state: "ended" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    world.reachable.add("192.168.1.5:47621");
    for (const listener of world.appState.listeners) listener("active");
    await vi.advanceTimersByTimeAsync(0);
    expect(latest().sent).toContainEqual({ ...ringing, state: "ended" });
  });
});

describe("pairing", () => {
  const code = (expiresAt: number) => encodePairingCode({ pcId: "pc-2", pcPub: "B".repeat(43), secret: "C".repeat(43), hosts: ["192.168.1.9:47621"], expiresAt });

  beforeEach(() => {
    world.pc = null;
    world.reachable.add("192.168.1.9:47621");
  });

  it("lets the PC decide whether the code is still good", async () => {
    const store = await start();
    // By this phone's clock the code ran out three minutes ago; the PC's clock may differ.
    await store.getState().pair(code(Date.now() - 180_000), "Pixel");
    expect(store.getState().pc).toMatchObject({ pcId: "pc-2", pcName: "Neuer PC", deviceId: "device-2" });
  });

  it("keeps the pairing when the fingerprint was cancelled, so it can be tried again", async () => {
    const store = await start();
    world.saveKeysFails = true;
    await expect(store.getState().pair(code(Date.now() + 60_000), "Pixel")).rejects.toThrow(/Fingerabdruck/);
    expect(store.getState().pairingPending).toBe(true);
    expect(store.getState().pc).toBeNull();

    world.saveKeysFails = false;
    await store.getState().finishPairing();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().pairingPending).toBe(false);
    expect(store.getState().pc?.pcId).toBe("pc-2");
    expect(store.getState().link).toBe("online");
  });

  it("tries an address typed by hand beside the ones in the code", async () => {
    world.reachable.clear();
    world.reachable.add("192.168.178.98:47621");
    const store = await start();
    await store.getState().pair(code(Date.now() + 60_000), "Pixel", "192.168.178.98");
    expect(store.getState().pc?.hosts[0]).toBe("192.168.178.98:47621");
  });

  it("rejects a QR code that isn't NOVA's", async () => {
    const store = await start();
    await expect(store.getState().pair("https://example.com", "Pixel")).rejects.toThrow("Das ist kein Kopplungscode von NOVA.");
  });
});

describe("background sync", () => {
  it("uses the app's one connection and saves afterwards", async () => {
    world.appState.currentState = "background";
    const { useCompanion } = await import("./store");
    const { saveState } = await import("./storage");
    const done = useCompanion.getState().sync(8000);
    await vi.advanceTimersByTimeAsync(8000);
    await done;
    expect(world.sessions).toHaveLength(1);
    expect(latest().types()).toContain("notices.get");
    expect(vi.mocked(saveState)).toHaveBeenCalled();
  });
});
