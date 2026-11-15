import { BarChart3, ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import { SettingCard, SettingLine } from "@/components/settings-kit";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Switch } from "@/components/ui/Switch";
import { notifyError } from "@/features/notifications/store";
import { recordChange } from "@/features/settings/recent";
import { FIELD } from "@/features/settings/SettingsLayout";
import { cn } from "@/lib/cn";
import { callNative } from "@/lib/native";
import { useRecentEvents, useTelemetryDecision, useTelemetryName, useTelemetryStatus } from "./api";

function when(ms: number): string {
  return new Date(ms).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
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

  // Turning it off is decided in a dialog outside this page, so the change is noted here.
  const set = (accepted: boolean) => {
    decide.mutate(accepted, { onError: (error) => notifyError("Deine Entscheidung ließ sich nicht speichern", error) });
    recordChange("privacy", "Nutzungsstatistik senden");
  };
  const shownName = name ?? status.displayName ?? "";

  return (
    <SettingCard title="Nutzungsstatistik" description="Freiwillig, und aus, bis du zustimmst. Was gesendet wird, kannst du dir hier ansehen." icon={BarChart3}>
      {/* Flipping the switch off only opens the dialog: no change yet. */}
      <div data-no-record>
        <SettingLine
          label="Nutzungsstatistik senden"
          description={status.accepted ? `An seit ${status.decidedAt ? when(status.decidedAt) : "deiner Zustimmung"}. Geht an ${status.host}. Ausschalten stoppt das sofort und löscht dort die Daten dieses PCs.` : "Aus. NOVA sendet keine Statistik."}
        >
          <Switch label="Nutzungsstatistik senden" checked={status.accepted} disabled={decide.isPending} onChange={(on) => (on ? set(true) : setConfirming(true))} />
        </SettingLine>
      </div>
      {status.accepted && (
        <SettingLine label="Name in der Statistik" htmlFor={nameId} description="Freiwillig. Ohne Namen bist du eine zufällige Kennung.">
          <input
            id={nameId}
            value={shownName}
            maxLength={40}
            placeholder="Kein Name"
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              if (name !== null && name !== (status.displayName ?? "")) saveName.mutate(name.trim() || null, { onError: (error) => notifyError("Der Name ließ sich nicht speichern", error) });
              setName(null);
            }}
            className={cn(FIELD, "w-56")}
          />
        </SettingLine>
      )}
      <div className="pt-3.5">
        {status.lastError && status.accepted && <p className="mb-3 text-[12px] text-warning">Letzter Versuch: {status.lastError}. NOVA versucht es von selbst wieder.</p>}
        <div className="flex flex-wrap gap-2">
          {status.accepted && (
            <Button size="sm" variant="secondary" aria-expanded={showing} onClick={() => setShowing((now) => !now)}>
              {showing ? "Gesendetes ausblenden" : "Zeigen, was gesendet wird"}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<ExternalLink size={13} aria-hidden />} onClick={() => void callNative("open_url", { url: status.privacyUrl }).catch((error: unknown) => notifyError("Die Seite ließ sich nicht öffnen", error))}>
            Datenschutzhinweis
          </Button>
          {showing && recent && recent.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(JSON.stringify(recent.map((row) => row.body), null, 2))}>
              Als JSON kopieren
            </Button>
          )}
        </div>
        {showing && (
          <div className="mt-3 max-h-64 overflow-y-auto rounded-[10px] border border-line bg-black/25 p-2.5 font-mono text-[11px] leading-relaxed text-fg-muted select-text">
            {recent?.length ? (
              recent.map((row, index) => (
                <p key={`${row.at}-${index}`} className="truncate">
                  <span className={row.sentAt ? "text-success" : "text-warning"}>{row.sentAt ? "gesendet" : "wartet  "}</span> {when(row.at)} {String(row.body.type)} {row.body.name ? String(row.body.name) : ""} {row.body.value ? String(row.body.value) : ""}
                </p>
              ))
            ) : (
              <p>Noch nichts.</p>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title="Keine Statistik mehr senden?"
        description="NOVA hört sofort auf und löscht die Daten dieses PCs beim Statistik-Dienst. Es bleiben nur Summen, die sich nicht mit dir verbinden lassen."
        confirmLabel="Stoppen und löschen"
        cancelLabel="Abbrechen"
        danger
        onClose={() => setConfirming(false)}
        onConfirm={() => set(false)}
      />
    </SettingCard>
  );
}
