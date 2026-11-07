import { BarChart3, ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Switch } from "@/components/ui/Switch";
import { notifyError } from "@/features/notifications/store";
import { SettingRow } from "@/features/settings/SettingsLayout";
import { callNative } from "@/lib/native";
import { useRecentEvents, useTelemetryDecision, useTelemetryName, useTelemetryStatus } from "./api";

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/** The switch that withdraws consent, and a view of what actually left this PC. */
export function TelemetrySettings() {
  const { data: status } = useTelemetryStatus();
  const decide = useTelemetryDecision();
  const saveName = useTelemetryName();
  const [confirming, setConfirming] = useState(false);
  const [showing, setShowing] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const nameId = useId();
  const { data: recent } = useRecentEvents(showing);
  if (!status) return null;

  const set = (accepted: boolean) => decide.mutate(accepted, { onError: (error) => notifyError("NOVA couldn't save your decision", error) });
  const shownName = name ?? status.displayName ?? "";

  return (
    <div className="mb-4 rounded-[14px] border border-line bg-black/20 p-4">
      <p className="mb-1 flex items-center gap-2 text-[13px] font-medium text-fg">
        <BarChart3 size={14} className="text-accent-text" aria-hidden /> Usage statistics
      </p>
      <SettingRow
        label="Send usage statistics"
        description={status.accepted ? `On since ${status.decidedAt ? when(status.decidedAt) : "you agreed"}. Goes to ${status.host}. Turning this off stops it at once and deletes this PC's data there.` : "Off. NOVA sends no statistics."}
      >
        <Switch label="Send usage statistics" checked={status.accepted} disabled={decide.isPending} onChange={(on) => (on ? set(true) : setConfirming(true))} />
      </SettingRow>
      {status.accepted && (
        <SettingRow label="Name in the statistics" htmlFor={nameId} description="Optional. Without one you are a random id.">
          <input
            id={nameId}
            value={shownName}
            maxLength={40}
            placeholder="No name"
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              if (name !== null && name !== (status.displayName ?? "")) saveName.mutate(name.trim() || null, { onError: (error) => notifyError("Couldn't save the name", error) });
              setName(null);
            }}
            className="h-9 w-56 rounded-control border border-line bg-black/25 px-3 text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle focus:border-line-strong"
          />
        </SettingRow>
      )}
      {status.lastError && status.accepted && <p className="mt-2 text-[12px] text-warning">Last attempt: {status.lastError}. NOVA tries again by itself.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {status.accepted && (
          <Button size="sm" variant="secondary" onClick={() => setShowing((v) => !v)}>
            {showing ? "Hide what is sent" : "Show what is sent"}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void callNative("open_url", { url: status.privacyUrl }).catch((error: unknown) => notifyError("Couldn't open the page", error))}>
          Privacy notice
        </Button>
        {showing && recent && recent.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(JSON.stringify(recent.map((r) => r.body), null, 2))}>
            Copy as JSON
          </Button>
        )}
      </div>
      {showing && (
        <div className="mt-3 max-h-64 overflow-y-auto rounded-[10px] border border-line bg-black/25 p-2.5 font-mono text-[11px] leading-relaxed text-fg-muted select-text">
          {recent?.length ? (
            recent.map((row, index) => (
              <p key={`${row.at}-${index}`} className="truncate">
                <span className={row.sentAt ? "text-success" : "text-warning"}>{row.sentAt ? "sent   " : "waiting"}</span> {when(row.at)} {String(row.body.type)} {row.body.name ? String(row.body.name) : ""} {row.body.value ? String(row.body.value) : ""}
              </p>
            ))
          ) : (
            <p>Nothing yet.</p>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title="Stop sending statistics?"
        description="NOVA stops at once and deletes the data of this PC on the statistics service. Only totals that can't be linked to you remain."
        confirmLabel="Stop and delete"
        danger
        onClose={() => setConfirming(false)}
        onConfirm={() => set(false)}
      />
    </div>
  );
}
