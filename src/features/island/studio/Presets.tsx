import { Check, ClipboardCopy, Download, Palette, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ChoiceCards, SettingCard } from "@/components/settings-kit";
import { Button, IconButton } from "@/components/ui/Button";
import { applyPreset, CURATED_PRESETS, decodePreset, encodePreset, matchingPreset, presetFrom } from "../presets";
import { type IslandPrefs, type IslandPreset, LIMITS } from "../types";
import { MiniPill } from "./MiniPill";
import type { UpdatePrefs } from "./useStudioPrefs";

const FIELD = "h-8 min-w-0 rounded-control border border-line bg-black/25 px-2.5 text-[12.5px] text-fg outline-none select-text placeholder:text-fg-subtle focus:border-line-strong";

function newId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** One preset of the user's own: apply it, rename it in place, copy its code, delete it. */
function OwnPreset({ preset, selected, onApply, onRename, onDelete }: { preset: IslandPreset; selected: boolean; onApply: () => void; onRename: (name: string) => void; onDelete: () => void }) {
  const [name, setName] = useState(preset.name);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(encodePreset(preset)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  };
  return (
    <li className="flex items-center gap-2 rounded-[14px] border border-line bg-white/[0.02] p-1.5">
      <button type="button" aria-label={`${preset.name} anwenden`} aria-pressed={selected} title="Anwenden" onClick={onApply} className="flex h-10 w-28 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-black/30 transition-colors hover:bg-black/45 aria-pressed:ring-1 aria-pressed:ring-accent">
        <MiniPill look={preset} width={96} />
      </button>
      <input
        aria-label={`Name von ${preset.name}`}
        value={name}
        maxLength={LIMITS.presetName}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => (name.trim() ? name.trim() !== preset.name && onRename(name) : setName(preset.name))}
        onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
        className={`${FIELD} flex-1 border-transparent bg-transparent font-medium hover:border-line`}
      />
      <IconButton label={copied ? "Code kopiert" : "Code kopieren"} size="sm" onClick={copy}>
        {copied ? <Check size={13} className="text-success" aria-hidden /> : <ClipboardCopy size={13} aria-hidden />}
      </IconButton>
      <IconButton label={`${preset.name} löschen`} size="sm" onClick={onDelete}>
        <Trash2 size={13} aria-hidden />
      </IconButton>
    </li>
  );
}

/** Curated looks, the user's own, and the code that carries a look somewhere else. */
export function Presets({ prefs, update }: { prefs: IslandPrefs; update: UpdatePrefs }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const full = prefs.presets.length >= LIMITS.presets;
  const current = matchingPreset(prefs, prefs.presets);

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (full) return;
    update((now) => ({ ...now, presets: [...now.presets, presetFrom(now, name || `Mein Look ${now.presets.length + 1}`, newId())] }));
    setName("");
  };

  const load = (event: FormEvent) => {
    event.preventDefault();
    const decoded = decodePreset(code);
    if (!decoded.ok) return setProblem(decoded.reason);
    if (full) return setProblem(`Mehr als ${LIMITS.presets} eigene Vorlagen gehen nicht. Lösch erst eine.`);
    const preset: IslandPreset = { ...decoded.preset, id: newId() };
    // Imported and applied in one step, so one undo takes both back.
    update((now) => applyPreset({ ...now, presets: [...now.presets, preset] }, preset));
    setCode("");
    setProblem(null);
  };

  return (
    <SettingCard title="Vorlagen" description="Ein fertiger Look mit einem Klick. Form, Material, Bewegung und Seitenslots wechseln, alles andere bleibt." icon={Palette}>
      <div data-setting="Vorlagen" className="pb-3.5">
        <ChoiceCards
          label="Kuratierte Vorlagen"
          value={matchingPreset(prefs, CURATED_PRESETS)?.id ?? null}
          options={CURATED_PRESETS.map((preset) => ({ value: preset.id, label: preset.name, description: preset.description, preview: <MiniPill look={preset} /> }))}
          onChange={(id) => {
            const preset = CURATED_PRESETS.find((p) => p.id === id);
            if (preset) update((now) => applyPreset(now, preset));
          }}
        />
      </div>

      <div className="space-y-2.5 py-3.5">
        <p className="text-[13px] font-medium text-fg">Eigene Vorlagen</p>
        {prefs.presets.length > 0 && (
          <ul aria-label="Eigene Vorlagen" className="space-y-1.5">
            {prefs.presets.map((preset) => (
              <OwnPreset
                key={preset.id}
                preset={preset}
                selected={current?.id === preset.id}
                onApply={() => update((now) => applyPreset(now, preset))}
                onRename={(next) => update((now) => ({ ...now, presets: now.presets.map((p) => (p.id === preset.id ? { ...p, name: next.trim().slice(0, LIMITS.presetName) } : p)) }))}
                onDelete={() => update((now) => ({ ...now, presets: now.presets.filter((p) => p.id !== preset.id) }))}
              />
            ))}
          </ul>
        )}
        <form onSubmit={save} className="flex items-center gap-2">
          <input aria-label="Name der neuen Vorlage" value={name} maxLength={LIMITS.presetName} placeholder="Name für den aktuellen Look" disabled={full} onChange={(event) => setName(event.target.value)} className={`${FIELD} flex-1`} />
          <Button size="sm" type="submit" disabled={full} icon={<Plus size={13} aria-hidden />}>
            Speichern
          </Button>
        </form>
        {full && <p className="text-[12px] text-fg-subtle">{LIMITS.presets} eigene Vorlagen sind das Maximum.</p>}
      </div>

      <form onSubmit={load} className="space-y-2 pt-3.5">
        <label htmlFor="island-preset-code" className="text-[13px] font-medium text-fg">
          Vorlage importieren
        </label>
        <div className="flex items-center gap-2">
          <input
            id="island-preset-code"
            value={code}
            spellCheck={false}
            placeholder="NI1.…"
            aria-invalid={problem !== null}
            aria-describedby={problem ? "island-preset-problem" : undefined}
            onChange={(event) => {
              setCode(event.target.value);
              setProblem(null);
            }}
            className={`${FIELD} flex-1 font-mono text-[12px]`}
          />
          <Button size="sm" type="submit" disabled={code.trim() === ""} icon={<Download size={13} aria-hidden />}>
            Importieren
          </Button>
        </div>
        {problem ? (
          <p id="island-preset-problem" role="alert" className="text-[12px] text-warning">
            {problem}
          </p>
        ) : (
          <p className="text-[12px] text-fg-subtle">Den Code einer eigenen Vorlage kopierst du mit dem Symbol in ihrer Zeile.</p>
        )}
      </form>
    </SettingCard>
  );
}
