import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { QrCode, Smartphone, Trash2, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Switch";
import { SettingRow, SettingsSection } from "@/features/settings/SettingsLayout";
import { notifyError } from "@/features/notifications/store";
import { callNative, isDesktop } from "@/lib/native";

/** Mirrors `CompanionStatus` and friends in src-tauri/src/companion/mod.rs. */
export interface AllowedApp {
  kind: "app" | "game";
  id: string;
  name: string;
}
export interface PairedDevice {
  id: string;
  name: string;
  platform: string;
  pairedAt: number;
  lastSeen: number | null;
  connected: boolean;
}
export interface CompanionStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  addresses: string[];
  error: string | null;
  keepScreenshots: boolean;
  allowlist: AllowedApp[];
  devices: PairedDevice[];
  pairRequest: { deviceName: string; platform: string } | null;
}
interface Pairing {
  svg: string;
  expiresAt: number;
}
interface LogEntry {
  id: string;
  device: string;
  text: string;
  state: string;
  runAt: string | null;
  createdAt: number;
  finishedAt: number | null;
  result: string | null;
}

const KEY = ["companion"] as const;
const LOG_KEY = ["companion", "log"] as const;
const INPUT = "h-9 rounded-control border border-line bg-black/25 px-3 text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle focus:border-line-strong";

/** "Seen 5 min ago", "Connected", "Never connected". */
export function seenText(device: PairedDevice, now = Date.now()): string {
  if (device.connected) return "Connected";
  if (device.lastSeen === null) return "Never connected";
  const minutes = Math.round((now - device.lastSeen) / 60_000);
  if (minutes < 1) return "Seen just now";
  if (minutes < 60) return `Seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Seen ${hours} h ago`;
  return `Seen ${Math.round(hours / 24)} days ago`;
}

/** NOVA Companion: pair phones, see and remove them, and choose what they may start freely. */
export function CompanionSettings() {
  const client = useQueryClient();
  const { data: status } = useQuery({ queryKey: KEY, queryFn: () => callNative<CompanionStatus>("companion_status"), enabled: isDesktop() });
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [now, setNow] = useState(Date.now());
  const [removing, setRemoving] = useState<PairedDevice | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [adding, setAdding] = useState("");
  const addId = useId();

  useEffect(() => {
    if (!isTauri()) return;
    const refresh = () => void client.invalidateQueries({ queryKey: KEY });
    const stops = [listen("companion://changed", refresh), listen("companion://pair-request", refresh)];
    return () => stops.forEach((stop) => void stop.then((unlisten) => unlisten()).catch(() => {}));
  }, [client]);

  // The QR code's countdown; it disappears when the code is no longer valid.
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);
  useEffect(() => {
    if (pairing && now > pairing.expiresAt) setPairing(null);
  }, [now, pairing]);
  // Paired or declined: the code was used.
  const deviceCount = status?.devices.length ?? 0;
  useEffect(() => setPairing(null), [deviceCount]);

  const save = (data: CompanionStatus) => client.setQueryData(KEY, data);
  const configure = useMutation({
    mutationFn: (update: { enabled?: boolean; keepScreenshots?: boolean }) => callNative<CompanionStatus>("companion_configure", update),
    onSuccess: save,
    onError: (error) => notifyError("NOVA couldn't change the phone connection", error),
  });
  const startPairing = useMutation({
    mutationFn: () => callNative<Pairing>("companion_pair_start"),
    onSuccess: (data) => {
      setNow(Date.now());
      setPairing(data);
    },
    onError: (error) => notifyError("NOVA couldn't make a pairing code", error),
  });
  const decide = useMutation({
    mutationFn: (approved: boolean) => callNative("companion_pair_decide", { approved }),
    onSettled: () => void client.invalidateQueries({ queryKey: KEY }),
  });
  const revoke = useMutation({
    mutationFn: (deviceId: string) => callNative<CompanionStatus>("companion_revoke", { deviceId }),
    onSuccess: save,
    onError: (error) => notifyError("NOVA couldn't remove the phone", error),
  });
  const candidates = useQuery({ queryKey: ["companion", "candidates"], queryFn: () => callNative<AllowedApp[]>("companion_allow_candidates"), enabled: isDesktop() && Boolean(status?.enabled) });
  const setAllowlist = useMutation({
    mutationFn: (allowlist: AllowedApp[]) => callNative<CompanionStatus>("companion_set_allowlist", { allowlist }),
    onSuccess: save,
    onError: (error) => notifyError("NOVA couldn't save the list", error),
  });
  const log = useQuery({ queryKey: LOG_KEY, queryFn: () => callNative<LogEntry[]>("companion_log"), enabled: isDesktop() && showLog });
  const clearLog = useMutation({ mutationFn: () => callNative("companion_clear_log"), onSuccess: () => void client.invalidateQueries({ queryKey: LOG_KEY }) });

  if (!isDesktop()) {
    return (
      <SettingsSection id="phone" title="Phone" description="Send tasks to NOVA AI from your phone." icon={Smartphone}>
        <p className="text-[13px] text-fg-muted">Available in the NOVA desktop app.</p>
      </SettingsSection>
    );
  }
  if (!status) return null;

  const addApp = (name: string) => {
    const found = candidates.data?.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    if (!found || status.allowlist.some((a) => a.kind === found.kind && a.id === found.id)) return;
    setAllowlist.mutate([...status.allowlist, found]);
    setAdding("");
  };
  const secondsLeft = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <SettingsSection
      id="phone"
      title="Phone"
      description="NOVA Companion: ask NOVA AI from your phone, start apps, approve changes with your fingerprint. Everything stays encrypted between your phone and this PC; the AI and its keys stay here."
      icon={Smartphone}
    >
      <SettingRow
        label="Phone connection"
        description={
          status.enabled
            ? status.listening
              ? `Paired phones on your network reach this PC at ${status.addresses.join(", ") || "no network address yet"} (port ${status.port}).`
              : "Not reachable right now."
            : "Off. When you turn it on, Windows may ask once whether NOVA may use private networks: allow it there, not on public networks."
        }
      >
        <Switch label="Phone connection" checked={status.enabled} disabled={configure.isPending} onChange={(enabled) => configure.mutate({ enabled })} />
      </SettingRow>
      {status.error && <p className="py-1 text-[12px] text-warning">{status.error}</p>}

      {status.enabled && status.listening && (
        <SettingRow label="Pair a phone" description="Open NOVA Companion on your phone and scan the code. It works once, for two minutes.">
          <Button size="sm" variant="secondary" icon={<QrCode size={13} />} disabled={startPairing.isPending} onClick={() => startPairing.mutate()}>
            Show code
          </Button>
        </SettingRow>
      )}
      {pairing && (
        <div className="flex items-center gap-5 py-3">
          <img src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.svg)}`} alt="Pairing code for NOVA Companion" className="size-48 rounded-[12px] bg-white p-2" />
          <div className="space-y-2 text-[12.5px] text-fg-muted">
            <p>Valid for {secondsLeft} more seconds. Only scan it with your own phone: NOVA asks you here before the phone is paired.</p>
            <Button
              size="sm"
              variant="ghost"
              icon={<X size={13} />}
              onClick={() => {
                setPairing(null);
                void callNative("companion_pair_cancel").catch(() => {});
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {status.devices.length > 0 && (
        <div className="py-3">
          <p className="text-[13.5px] font-medium text-fg">Paired phones</p>
          <ul className="mt-2 divide-y divide-line">
            {status.devices.map((device) => (
              <li key={device.id} className="flex items-center justify-between gap-4 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-fg">{device.name}</p>
                  <p className="text-[12px] text-fg-muted">
                    <span className={device.connected ? "text-success" : undefined}>{seenText(device, now)}</span> · {device.platform === "ios" ? "iPhone" : "Android"} · paired {new Date(device.pairedAt).toLocaleDateString()}
                  </p>
                </div>
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setRemoving(device)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {status.enabled && (
        <SettingRow
          label="Start without fingerprint"
          htmlFor={addId}
          description="Apps and games a phone may start right away. Everything else that changes something on this PC needs your fingerprint on the phone; settings, keys, accounts and purchases never work from the phone."
        >
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              addApp(adding);
            }}
          >
            <input id={addId} list={`${addId}-list`} value={adding} onChange={(event) => setAdding(event.target.value)} placeholder="App or game" className={`${INPUT} w-48`} />
            <datalist id={`${addId}-list`}>
              {candidates.data?.map((c) => (
                <option key={`${c.kind}:${c.id}`} value={c.name} />
              ))}
            </datalist>
            <Button size="sm" type="submit" disabled={!adding.trim() || setAllowlist.isPending}>
              Add
            </Button>
          </form>
        </SettingRow>
      )}
      {status.allowlist.length > 0 && (
        <ul className="flex flex-wrap gap-2 pb-3" aria-label="Apps phones may start">
          {status.allowlist.map((entry) => (
            <li key={`${entry.kind}:${entry.id}`} className="flex items-center gap-1 rounded-full border border-line bg-white/[0.04] py-1 pr-1 pl-3 text-[12.5px] text-fg">
              {entry.name}
              <button
                type="button"
                aria-label={`Remove ${entry.name}`}
                className="rounded-full p-1 text-fg-muted hover:bg-white/[0.08] hover:text-fg"
                onClick={() => setAllowlist.mutate(status.allowlist.filter((a) => !(a.kind === entry.kind && a.id === entry.id)))}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <SettingRow label="Keep phone screenshots" description="Off: screenshots go to the phone and are not stored on this PC. On: NOVA also keeps them here for 7 days.">
        <Switch label="Keep phone screenshots" checked={status.keepScreenshots} disabled={configure.isPending} onChange={(keepScreenshots) => configure.mutate({ keepScreenshots })} />
      </SettingRow>

      <SettingRow label="Tasks from phones" description="Stays on this PC. Each step NOVA took is also in NOVA AI's action history, marked “Phone”.">
        <Button size="sm" variant="secondary" onClick={() => setShowLog((open) => !open)}>
          {showLog ? "Hide" : "Show"}
        </Button>
      </SettingRow>
      {showLog && (
        <div className="pb-2">
          {log.data?.length ? (
            <ul className="max-h-72 divide-y divide-line overflow-y-auto">
              {log.data.map((entry) => (
                <li key={entry.id} className="py-2 text-[12.5px]">
                  <p className="text-fg">{entry.text}</p>
                  <p className="text-fg-muted">
                    {entry.device} · {new Date(entry.createdAt).toLocaleString()} · {entry.state}
                    {entry.runAt ? ` · for ${entry.runAt}` : ""}
                  </p>
                  {entry.result && <p className="mt-0.5 line-clamp-2 text-fg-subtle">{entry.result}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-fg-muted">No tasks from phones yet.</p>
          )}
          {Boolean(log.data?.length) && (
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => clearLog.mutate()}>
              Clear finished tasks
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title={`Remove “${removing?.name ?? ""}”?`}
        description="The phone can't reach this PC anymore, at once. Its waiting tasks are cancelled. To use it again, pair it anew."
        confirmLabel="Remove"
        danger
        onConfirm={() => removing && revoke.mutate(removing.id)}
        onClose={() => setRemoving(null)}
      />
      <Dialog
        open={status.pairRequest !== null}
        onClose={() => decide.mutate(false)}
        title={`Pair “${status.pairRequest?.deviceName ?? ""}”?`}
        description="This phone scanned your pairing code. Once paired, it can ask NOVA AI and start the apps you allowed; changes need your fingerprint on the phone."
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => decide.mutate(false)} data-autofocus>
              Don't pair
            </Button>
            <Button size="sm" variant="primary" onClick={() => decide.mutate(true)}>
              Pair
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </SettingsSection>
  );
}
