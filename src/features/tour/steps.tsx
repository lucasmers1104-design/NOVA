import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { ArrowRight, AudioLines, Check, CircleCheck, Download, Ear, ExternalLink, KeyRound, type LucideIcon, MessageCircle, Play, ShieldCheck, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import { type ComponentType, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { NAV_ITEMS, type RouteId } from "@/app/navigation";
import { NovaMark } from "@/components/brand/NovaMark";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { ACCENT_PRESETS, deriveAccentTokens } from "@/design/accent";
import { PROVIDERS, type ProviderId, useKeyStatus, useSaveKey } from "@/features/ai/api";
import { useAgent } from "@/features/nova-assistant/AgentSettings";
import { assistantStatus, openWebPage, toggleAssistant } from "@/features/nova-assistant/api";
import { shortcutLabels } from "@/features/nova-assistant/shortcut";
import { formatBytes, type SpeechItem, useSpeech } from "@/features/nova-assistant/speech/api";
import { ASSISTANT_EVENTS } from "@/features/nova-assistant/types";
import { installNovaVoice, openVoiceSettings, speak, useVoice, watchNovaVoice } from "@/features/nova-assistant/voice";
import { configureWake, type Heard, testWake, wakeStatus, type WakeListener, type WakePrefs, type WakeStatus } from "@/features/nova-assistant/wake";
import { notifyError } from "@/features/notifications/store";
import { useProfile } from "@/features/profile/useProfile";
import { cn } from "@/lib/cn";
import { isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useTour } from "./store";

export const TOUR_TITLE_ID = "nova-tour-title";

const WAKE_KEY = ["wake", "status"] as const;
const inputClass = "h-10 w-full min-w-0 rounded-control border border-line bg-black/25 px-3 text-[13.5px] text-fg outline-none select-text placeholder:text-fg-subtle focus:border-line-strong";

function Heading({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 id={TOUR_TITLE_ID} className="text-[21px] leading-tight font-semibold tracking-tight text-fg">
        {title}
      </h2>
      {children && <p className="mt-1.5 text-[13.5px] leading-relaxed text-fg-muted">{children}</p>}
    </div>
  );
}

function Keys({ keys, lit = false }: { keys: readonly string[]; lit?: boolean }) {
  return (
    <span className="inline-flex gap-1">
      {keys.map((key) => (
        <kbd key={key} className={cn("rounded-[7px] border px-1.5 py-0.5 font-sans text-[11.5px] font-medium transition-colors duration-200", lit ? "border-success/40 bg-success/15 text-success" : "border-line-strong bg-white/[0.07] text-fg")}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

function Orb({ size = 84 }: { size?: number }) {
  return (
    <div className="relative mb-4 flex justify-center" style={{ height: size }}>
      <span aria-hidden className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl" style={{ height: size * 1.4, width: size * 2.4, background: "var(--nova-accent-glow)" }} />
      <NovaMark size={size} className="relative animate-[nova-tour-float_5s_ease-in-out_infinite]" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hello
// ---------------------------------------------------------------------------

function HelloStep() {
  const displayName = useSettings((s) => s.displayName);
  const setDisplayName = useSettings((s) => s.setDisplayName);
  const profile = useProfile();
  const goTo = useTour((s) => s.goTo);
  return (
    <div className="pt-4 text-center">
      <Orb />
      <Heading title={`Hi${profile.firstName ? ` ${profile.firstName}` : ""}, ich bin NOVA.`}>Ich zeige dir in ein paar Minuten alles, was ich kann. Du probierst es direkt aus, und alles lässt sich später ändern.</Heading>
      <form
        className="mx-auto mt-5 max-w-72 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          goTo(1);
        }}
      >
        <label htmlFor="nova-tour-name" className="mb-1.5 block text-[12.5px] text-fg-muted">
          Wie soll ich dich nennen?
        </label>
        <input id="nova-tour-name" autoFocus value={displayName} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} placeholder={profile.fullName ?? "Dein Name"} className={inputClass} />
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

function LookStep() {
  const accent = useSettings((s) => s.accent);
  const setAccent = useSettings((s) => s.setAccent);
  const transparency = useSettings((s) => s.transparency);
  const setTransparency = useSettings((s) => s.setTransparency);
  const complete = useTour((s) => s.complete);
  return (
    <>
      <Heading title="Mach mich zu deinem NOVA.">Klick eine Farbe an, und ich trage sie sofort. Auch diese Karte hier.</Heading>
      <div role="radiogroup" aria-label="Akzentfarbe" className="grid grid-cols-5 gap-2.5">
        {ACCENT_PRESETS.map((preset) => {
          const selected = accent.kind === "preset" && accent.id === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setAccent({ kind: "preset", id: preset.id });
                complete("look");
              }}
              className={cn("group flex flex-col items-center gap-2 rounded-[16px] border p-3 transition-colors", selected ? "border-line-strong bg-white/[0.07]" : "border-line bg-white/[0.02] hover:bg-white/[0.05]")}
            >
              <span className="flex size-11 items-center justify-center rounded-full transition-transform duration-200 ease-nova group-hover:scale-110" style={{ backgroundColor: preset.color, boxShadow: selected ? `0 6px 22px -4px ${preset.color}` : undefined }}>
                {selected && <Check size={18} strokeWidth={2.8} style={{ color: deriveAccentTokens(preset.color).onAccent }} aria-hidden />}
              </span>
              <span className="text-center text-[11.5px] leading-tight text-fg-muted">{preset.name}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 rounded-[16px] border border-line bg-white/[0.02] px-4 py-3">
        <div>
          <p className="text-[13px] font-medium text-fg">Glas-Effekte</p>
          <p className="text-[12px] text-fg-muted">Sieht schick aus. Auf schwächeren PCs läuft es ohne etwas flüssiger.</p>
        </div>
        <Switch label="Glas-Effekte" checked={transparency} onChange={setTransparency} />
      </div>
      <p className="mt-3 text-[12px] text-fg-subtle">Hintergründe und eigene Farben findest du später unter Settings → Appearance.</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

const BARS = [0.45, 0.8, 0.55, 1, 0.65, 0.9, 0.5, 0.75, 1, 0.6, 0.85, 0.5, 0.7, 0.4];

/** Moves while NOVA talks. */
function Wave({ active }: { active: boolean }) {
  const mode = useVoice((s) => s.mode);
  const speaking = active && mode === "speaking";
  return (
    <div aria-hidden className="flex h-9 items-center justify-center gap-[3px]">
      {BARS.map((height, index) => (
        <span
          key={index}
          className={cn("w-[3px] origin-center rounded-full transition-colors duration-300", active ? "bg-accent" : "bg-white/[0.14]", speaking && "animate-[nova-eq_0.9s_ease-in-out_infinite]")}
          style={{ height: `${height * 100}%`, animationDelay: `${index * -70}ms`, transform: speaking ? undefined : "scaleY(0.3)" }}
        />
      ))}
    </div>
  );
}

const QUALITY: Record<string, string> = { x_low: "einfach", low: "gut", medium: "natürlich", high: "sehr natürlich" };

function OtherVoices({ say }: { say: string }) {
  const { status, install } = useSpeech();
  const agent = useAgent();
  const [open, setOpen] = useState(false);
  const prefs = agent.status?.prefs;
  const voices = status?.items.filter((item: SpeechItem) => item.kind === "voice" && item.id !== "thorsten" && !item.experimental) ?? [];
  if (voices.length === 0) return null;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 flex items-center gap-1 text-[12.5px] text-accent-text hover:underline">
        Andere Stimmen anhören <ArrowRight size={12} aria-hidden />
      </button>
    );
  }
  return (
    <ul className="mt-3 space-y-1.5">
      {voices.map((voice) => {
        const value = `nova:${voice.id}`;
        const chosen = prefs?.voice === value;
        return (
          <li key={voice.id} className="flex items-center justify-between gap-3 rounded-[12px] border border-line bg-white/[0.02] px-3 py-2">
            <div className="min-w-0">
              <p className="text-[13px] text-fg">{voice.label}</p>
              <p className="text-[11.5px] text-fg-subtle">
                {voice.gender === "female" ? "weiblich" : "männlich"} · {QUALITY[voice.quality] ?? voice.quality} · {voice.install.state === "downloading" ? `lädt … ${voice.install.percent} %` : formatBytes(voice.size)}
              </p>
              {voice.install.state === "failed" && <p className="text-[11.5px] text-danger">{voice.install.message}</p>}
            </div>
            {voice.install.state === "ready" ? (
              <span className="flex shrink-0 gap-1">
                <Button size="sm" variant="ghost" aria-label={`${voice.label} anhören`} icon={<Play size={13} aria-hidden />} disabled={!prefs} onClick={() => prefs && void speak(say, { ...prefs, voice: value }, "test", true)} />
                <Button size="sm" variant={chosen ? "secondary" : "ghost"} disabled={chosen} onClick={() => agent.update({ voice: value })}>
                  {chosen ? "Aktiv" : "Nehmen"}
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="ghost" icon={<Download size={13} aria-hidden />} disabled={voice.install.state === "downloading"} onClick={() => install(voice.id)}>
                {voice.install.state === "failed" ? "Nochmal" : "Laden"}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function VoiceStep() {
  const desktop = isDesktop();
  const novaVoice = useVoice((s) => s.novaVoice);
  const { status: agent } = useAgent();
  const profile = useProfile();
  const [own, setOwn] = useState("");
  const prefs = agent?.prefs;
  const hello = `Hallo${profile.firstName ? ` ${profile.firstName}` : ""}, schön, dich kennenzulernen.`;
  const ideas = [hello, "Sag einfach Hey NOVA, dann bin ich da.", "Soll ich dir einen Witz erzählen? Lieber nicht."];

  useEffect(() => (desktop ? watchNovaVoice() : undefined), [desktop]);

  // Only once it is here: speaking without it would start the download on its own.
  const say = (text: string) => {
    if (prefs) void speak(text, prefs, "test", true);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (own.trim()) say(own.trim());
  };

  return (
    <>
      <Heading title="Gib mir eine Stimme.">Thorsten ist eine natürlich klingende deutsche Stimme. Er läuft direkt auf deinem PC, auch ohne Internet, und was ich sage, verlässt dabei nicht deinen Rechner.</Heading>
      <div className="rounded-[18px] border border-line bg-white/[0.025] p-4">
        <Wave active={novaVoice?.state === "ready" || novaVoice?.state === "downloading"} />
        {novaVoice === null || !desktop ? (
          <p className="mt-3 text-center text-[13px] text-fg-muted">{desktop ? "Ich schaue kurz nach …" : "Das geht nur in der NOVA-App."}</p>
        ) : novaVoice.state === "missing" ? (
          <div className="mt-3 flex flex-col items-center gap-2">
            <Button variant="primary" icon={<Download size={15} aria-hidden />} onClick={() => void installNovaVoice()}>
              Thorsten herunterladen
            </Button>
            <p className="text-[12px] text-fg-subtle">Einmalig etwa 85 MB. Bis dahin spreche ich mit einer Windows-Stimme.</p>
          </div>
        ) : novaVoice.state === "downloading" ? (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[12.5px]">
              <span className="text-fg">Thorsten kommt …</span>
              <span className="font-medium text-fg tabular-nums">{novaVoice.percent} %</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-label="Download von Thorsten" aria-valuemin={0} aria-valuemax={100} aria-valuenow={novaVoice.percent}>
              <div className="accent-gradient h-full rounded-full transition-[width] duration-300 ease-out" style={{ width: `${novaVoice.percent}%` }} />
            </div>
            <p className="mt-2 text-[12px] text-fg-subtle">Du kannst schon weitermachen, der Download läuft im Hintergrund.</p>
          </div>
        ) : novaVoice.state === "failed" ? (
          <div className="mt-3 flex flex-col items-center gap-2 text-center">
            <p className="text-[12.5px] text-danger">{novaVoice.message}</p>
            <Button icon={<Download size={15} aria-hidden />} onClick={() => void installNovaVoice()}>
              Nochmal versuchen
            </Button>
          </div>
        ) : (
          <>
            <p className="mt-2 mb-2.5 flex items-center justify-center gap-1.5 text-[12.5px] font-medium text-success">
              <CircleCheck size={14} aria-hidden /> Thorsten ist da. Hör mal rein:
            </p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {ideas.map((idea) => (
                <button key={idea} type="button" disabled={!prefs} onClick={() => say(idea)} className="flex min-h-8 items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1 text-left text-[12px] text-fg transition-colors hover:bg-white/[0.11] disabled:opacity-50">
                  <Play size={11} className="shrink-0 text-accent-text" aria-hidden />
                  {idea}
                </button>
              ))}
            </div>
            <form className="mt-2.5 flex gap-2" onSubmit={submit}>
              <input value={own} onChange={(event) => setOwn(event.target.value)} aria-label="Was NOVA sagen soll" placeholder="Oder schreib, was ich sagen soll" className={inputClass} />
              <Button type="submit" size="md" disabled={!prefs || !own.trim()}>
                Sag's
              </Button>
            </form>
          </>
        )}
      </div>
      {novaVoice?.state === "ready" && <OtherVoices say={hello} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

function AiStep() {
  const { data: keys } = useKeyStatus();
  const save = useSaveKey();
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [key, setKey] = useState("");
  const info = PROVIDERS.find((p) => p.id === provider)!;
  const connected = keys?.[provider] ?? false;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim()) save.mutate({ provider, key: key.trim() }, { onSuccess: () => setKey("") });
  };

  return (
    <>
      <Heading title="Schließ mein Gehirn an.">Das ist optional. Ohne KI finde ich trotzdem deine Dateien und öffne Programme. Mit einem Schlüssel kann ich richtig mit dir reden und Aufgaben für dich erledigen.</Heading>
      <div role="radiogroup" aria-label="KI-Anbieter" className="grid grid-cols-3 gap-2">
        {PROVIDERS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={p.id === provider} onClick={() => setProvider(p.id)} className={cn("flex h-11 items-center justify-center gap-1.5 rounded-[14px] border text-[13px] transition-colors", p.id === provider ? "border-line-strong bg-white/[0.08] text-fg" : "border-line bg-white/[0.02] text-fg-muted hover:bg-white/[0.05]")}>
            {keys?.[p.id] && <Check size={13} className="text-success" aria-hidden />}
            {p.name}
          </button>
        ))}
      </div>
      {connected ? (
        <p className="mt-4 flex items-center gap-2 rounded-[14px] border border-success/25 bg-success/10 px-4 py-3 text-[13px] text-success">
          <CircleCheck size={15} aria-hidden /> {info.name} ist verbunden. Ich kann loslegen.
        </p>
      ) : (
        <ol className="mt-4 space-y-3 text-[13px] text-fg">
          <li className="flex items-center justify-between gap-3">
            <span>
              <span className="mr-2 text-fg-subtle tabular-nums">1</span>Hol dir einen Schlüssel bei {info.name}
            </span>
            <Button size="sm" icon={<ExternalLink size={13} aria-hidden />} onClick={() => void openWebPage(info.keyUrl).catch((error: unknown) => notifyError("Couldn't open the page", error))}>
              Seite öffnen
            </Button>
          </li>
          <li>
            <span className="mr-2 text-fg-subtle tabular-nums">2</span>Füg ihn hier ein
            <form className="mt-2 flex gap-2" onSubmit={submit}>
              <span className="relative min-w-0 flex-1">
                <KeyRound size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle" aria-hidden />
                <input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} aria-label={`Schlüssel für ${info.name}`} placeholder={info.keyHint} className={cn(inputClass, "pl-9")} />
              </span>
              <Button type="submit" variant="primary" disabled={!key.trim() || save.isPending}>
                Verbinden
              </Button>
            </form>
          </li>
        </ol>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-fg-subtle">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden />
        Der Schlüssel bleibt geschützt in Windows gespeichert. Deine Anfragen gehen direkt an den Anbieter, und was sie kosten, legt er fest.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Calling NOVA
// ---------------------------------------------------------------------------

const TRY_SAYING = ["Öffne meine Downloads", "Was bremst gerade meinen PC?", "Such meine letzte Rechnung"];

function useWakeStatus() {
  const desktop = isDesktop();
  const client = useQueryClient();
  const { data: status } = useQuery({ queryKey: WAKE_KEY, queryFn: wakeStatus, enabled: desktop });
  useEffect(() => {
    if (!desktop) return;
    const unlisten = listen<WakeStatus>(ASSISTANT_EVENTS.wakeStatus, (event) => client.setQueryData(WAKE_KEY, event.payload));
    return () => void unlisten.then((stop) => stop());
  }, [client, desktop]);
  const change = (patch: Partial<WakePrefs>) => {
    if (!status) return;
    configureWake({ ...status.prefs, ...patch }).then(
      (next) => client.setQueryData(WAKE_KEY, next),
      (error: unknown) => notifyError("Couldn't change that", error),
    );
  };
  const test = (on: boolean) => {
    testWake(on).then(
      (next) => client.setQueryData(WAKE_KEY, next),
      () => {},
    );
  };
  return { status, change, test };
}

function ListenerProblem({ listener }: { listener: WakeListener | undefined }) {
  if (listener?.state !== "unavailable") return null;
  return (
    <p className="mt-2 text-[12px] text-danger">
      {listener.message}{" "}
      {listener.settings && (
        <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => openVoiceSettings(listener.settings!)}>
          In Windows öffnen
        </button>
      )}
    </p>
  );
}

function CallStep() {
  const desktop = isDesktop();
  const { status, change, test } = useWakeStatus();
  const { data: assistant } = useQuery({ queryKey: ["tour", "assistant"], queryFn: assistantStatus, enabled: desktop });
  const complete = useTour((s) => s.complete);
  const heardIt = useTour((s) => s.missions.includes("wake"));
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState<string | null>(null);
  const autoTested = useRef(false);
  const prefs = status?.prefs;
  const listening = status?.phrase.state === "listening" || status?.clap.state === "listening";
  const testing = status?.testing ?? false;

  // The moment one is on, try it. Nothing opens during a test.
  useEffect(() => {
    if (!listening) autoTested.current = false;
    else if (!testing && !autoTested.current) {
      autoTested.current = true;
      test(true);
    }
  }, [listening, testing]);

  useEffect(() => {
    if (!desktop || !testing) {
      setLevel(0);
      return;
    }
    const unlisten = listen<Heard>(ASSISTANT_EVENTS.wakeHeard, ({ payload }) => {
      if (payload.kind === "level") setLevel(payload.value);
      else if ((payload.kind === "phrase" && payload.accepted) || (payload.kind === "double" && payload.veto === null)) complete("wake");
      else if (payload.kind === "phrase") setHeard(payload.text);
    });
    return () => void unlisten.then((stop) => stop());
  }, [desktop, testing, complete]);

  // Leaving the step ends the test.
  useEffect(() => () => void testWake(false).catch(() => {}), []);

  return (
    <>
      <Heading title="So rufst du mich.">Ich sitze als kleiner Punkt in deiner Taskleiste und bin überall da, auch wenn dieses Fenster zu ist.</Heading>
      <div className="grid grid-cols-2 gap-3">
        <section className="flex flex-col rounded-[18px] border border-line bg-white/[0.025] p-4">
          <h3 className="flex items-center gap-1.5 text-[13.5px] font-medium text-fg">
            <MessageCircle size={14} className="text-accent-text" aria-hidden /> Klicken oder drücken
          </h3>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">Klick auf den Punkt{assistant?.shortcut ? " oder drück " : "."}{assistant?.shortcut && <Keys keys={shortcutLabels(assistant.shortcut)} />}</p>
          <ul className="mt-2.5 space-y-1 text-[12px] text-fg-subtle">
            {TRY_SAYING.map((line) => (
              <li key={line}>„{line}“</li>
            ))}
          </ul>
          <Button size="sm" className="mt-3 self-start" disabled={!desktop} icon={<Sparkles size={13} aria-hidden />} onClick={() => void toggleAssistant().catch((error: unknown) => notifyError("Couldn't open NOVA AI", error))}>
            Jetzt ausprobieren
          </Button>
        </section>

        <section className="flex flex-col rounded-[18px] border border-line bg-white/[0.025] p-4">
          <h3 className="flex items-center gap-1.5 text-[13.5px] font-medium text-fg">
            <Ear size={14} className="text-accent-text" aria-hidden /> Einfach rufen
          </h3>
          <div className="mt-2 space-y-1.5">
            <label className="flex items-center justify-between gap-3 text-[12.5px] text-fg">
              „Hey NOVA“
              <Switch label="Hey NOVA" checked={prefs?.phrase ?? false} disabled={!prefs} onChange={(phrase) => change({ phrase })} />
            </label>
            <label className="flex items-center justify-between gap-3 text-[12.5px] text-fg">
              Zweimal klatschen
              <Switch label="Zweimal klatschen" checked={prefs?.clap ?? false} disabled={!prefs} onChange={(clap) => change({ clap })} />
            </label>
          </div>
          <ListenerProblem listener={prefs?.phrase ? status?.phrase : undefined} />
          <ListenerProblem listener={prefs?.clap ? status?.clap : undefined} />
          {testing && !heardIt && (
            <div className="mt-2.5">
              <p className="text-[12.5px] font-medium text-fg">Na los, ruf mich!</p>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]" role="meter" aria-label="Mikrofon-Pegel" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
                <div className="h-full rounded-full bg-accent transition-[width] duration-100 ease-out" style={{ width: `${Math.min(100, Math.sqrt(level) * 100)}%` }} />
              </div>
              {heard && <p className="mt-1.5 truncate text-[11.5px] text-fg-subtle">Verstanden: „{heard}“. Noch mal?</p>}
            </div>
          )}
          {heardIt && (
            <motion.p initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="mt-2.5 flex items-center gap-1.5 text-[13px] font-medium text-success">
              <CircleCheck size={15} aria-hidden /> Gehört! Das klappt.
            </motion.p>
          )}
          {listening && !testing && !heardIt && (
            <Button size="sm" className="mt-2.5 self-start" onClick={() => test(true)}>
              Nochmal testen
            </Button>
          )}
        </section>
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-fg-subtle">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden />
        Solange das an ist, bleibt das Mikrofon offen und Windows zeigt sein Mikrofon-Symbol. Der Ton wird nur auf diesem PC geprüft und nie aufgenommen, gespeichert oder gesendet.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// The walk through NOVA
// ---------------------------------------------------------------------------

const AREAS: Record<RouteId, string> = {
  home: "Dein Dashboard. Zieh Widgets herum, ändere ihre Größe und leg mehrere Layouts an.",
  system: "Prozessor, Arbeitsspeicher, Grafikkarte, Netzwerk und laufende Programme, alles live.",
  apps: "Durchsuche deine Programme, pinne Favoriten an und starte sie mit einem Klick.",
  ai: "Chatte hier mit Anthropic, OpenAI oder Gemini. Dein Verlauf bleibt erhalten.",
  productivity: "Aufgaben mit Erinnerungen, Projekte, Notizen und ein Kalender.",
  routines: "Was ich von selbst für dich erledige und was ich mir über dich merke.",
  media: "Steuere, was gerade läuft, zum Beispiel Spotify oder den Browser, dazu die Lautstärke.",
  files: "Standardordner, Favoriten und zuletzt benutzte Dateien an einem Ort.",
  live: "Wetter, Nachrichten aus deinen Feeds und Weltuhren.",
  studio: "Such dir Widgets aus, stell sie ein und leg sie aufs Dashboard.",
  plugins: "Erweitere mich mit signierten Plugins. Jedes bekommt nur die Rechte, die du erlaubst.",
  settings: "Hier stellst du alles ein. Ganz oben siehst du, was noch fehlt.",
};

/** How many sections count as having had a look around. */
const EXPLORE_GOAL = 3;

function ExploreStep() {
  const route = useUi((s) => s.route);
  const navigate = useUi((s) => s.navigate);
  const explored = useTour((s) => s.explored);
  const explore = useTour((s) => s.explore);
  const complete = useTour((s) => s.complete);
  const next = NAV_ITEMS.find((item) => !explored.includes(item.id));
  const current = NAV_ITEMS.find((item) => item.id === route);

  useEffect(() => {
    explore(route);
  }, [route, explore]);

  useEffect(() => {
    if (explored.length > EXPLORE_GOAL) complete("explore");
  }, [explored.length, complete]);

  // The real sidebar button that is next glows, so it gets clicked instead of the chips here.
  useEffect(() => {
    if (!next) return;
    const button = document.querySelector(`[data-nav="${next.id}"]`);
    button?.setAttribute("data-tour-glow", "");
    return () => button?.removeAttribute("data-tour-glow");
  }, [next]);

  return (
    <>
      <Heading title="Schau dich um.">Klick links in der Leiste auf das, was leuchtet. Das ist die echte App, also fass ruhig alles an.</Heading>
      {current && (
        <div key={current.id} className="rounded-[14px] border border-line bg-white/[0.03] px-3.5 py-3">
          <p className="text-[13px] font-medium text-fg">{current.label}</p>
          <p className="mt-0.5 min-h-[34px] text-[12.5px] leading-snug text-fg-muted">{AREAS[current.id]}</p>
        </div>
      )}
      <ul className="mt-3 grid grid-cols-6 gap-1.5" aria-label="Bereiche">
        {NAV_ITEMS.map((item) => {
          const Icon: LucideIcon = item.icon;
          const seen = explored.includes(item.id);
          return (
            <li key={item.id}>
              <button
                type="button"
                title={item.label}
                aria-label={item.label}
                aria-current={item.id === route ? "page" : undefined}
                onClick={() => navigate(item.id)}
                className={cn("relative flex h-9 w-full items-center justify-center rounded-[10px] transition-colors", item.id === route ? "bg-white/[0.12] text-accent-text" : seen ? "bg-white/[0.05] text-fg-muted hover:bg-white/[0.09]" : "bg-white/[0.02] text-fg-subtle hover:bg-white/[0.06]")}
              >
                <Icon size={15} strokeWidth={1.8} aria-hidden />
                {seen && <span aria-hidden className="absolute top-1 right-1 size-1 rounded-full bg-success" />}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2.5 text-right text-[11.5px] text-fg-subtle tabular-nums">
        {explored.length} von {NAV_ITEMS.length} entdeckt
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

function Mission({ keys, done, children }: { keys: readonly string[]; done: boolean; children: ReactNode }) {
  return (
    <li className={cn("flex items-center gap-3 rounded-[14px] border px-3 py-2.5 transition-colors duration-300", done ? "border-success/25 bg-success/[0.08]" : "border-line bg-white/[0.025]")}>
      <span className="flex size-5 shrink-0 items-center justify-center">{done ? <Check size={15} className="text-success" aria-hidden /> : <span aria-hidden className="size-2 rounded-full bg-white/[0.2]" />}</span>
      <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-fg">{children}</span>
      <Keys keys={keys} lit={done} />
    </li>
  );
}

function KeysStep() {
  const paletteOpen = useUi((s) => s.paletteOpen);
  const route = useUi((s) => s.route);
  const navigate = useUi((s) => s.navigate);
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const complete = useTour((s) => s.complete);
  const before = useRef(collapsed);
  const [done, setDone] = useState({ palette: false, sidebar: false, settings: false });

  useEffect(() => {
    navigate("home");
    const sidebar = before.current;
    return () => {
      useUi.getState().setPaletteOpen(false);
      useSettings.getState().setSidebarCollapsed(sidebar);
    };
  }, [navigate]);

  useEffect(() => {
    setDone((d) => ({ palette: d.palette || paletteOpen, sidebar: d.sidebar || collapsed !== before.current, settings: d.settings || route === "settings" }));
  }, [paletteOpen, collapsed, route]);

  useEffect(() => {
    if (done.palette && done.sidebar && done.settings) complete("keys");
  }, [done, complete]);

  return (
    <>
      <Heading title="Drei Kürzel, die alles schneller machen.">Drück sie einfach, sie funktionieren überall in NOVA.</Heading>
      <ul className="space-y-1.5">
        <Mission keys={["Ctrl", "K"]} done={done.palette}>
          Alles finden: Seiten, Apps, Aufgaben. <span className="text-fg-muted">Mit Esc wieder zu.</span>
        </Mission>
        <Mission keys={["Ctrl", "B"]} done={done.sidebar}>
          Die Seitenleiste einklappen
        </Mission>
        <Mission keys={["Ctrl", ","]} done={done.settings}>
          Direkt zu den Settings
        </Mission>
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

const SPARK_COUNT = 18;

/** A small burst behind the logo, once. */
function Sparks() {
  return (
    <div aria-hidden className="pointer-events-none absolute top-[58px] left-1/2">
      {Array.from({ length: SPARK_COUNT }, (_, index) => {
        const angle = (index / SPARK_COUNT) * Math.PI * 2;
        const reach = 90 + (index % 3) * 34;
        return (
          <motion.span
            key={index}
            className={cn("absolute size-1.5 rounded-full", index % 2 === 0 ? "bg-accent" : "bg-accent-text")}
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            animate={{ x: Math.cos(angle) * reach, y: Math.sin(angle) * reach, opacity: 0, scale: 0.3 }}
            transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
          />
        );
      })}
    </div>
  );
}

function DoneStep() {
  const desktop = isDesktop();
  const profile = useProfile();
  const displayName = useSettings((s) => s.displayName);
  const novaVoice = useVoice((s) => s.novaVoice);
  const { data: keys } = useKeyStatus();
  const { status: wake } = useWakeStatus();
  const { status: agent } = useAgent();
  const missions = useTour((s) => s.missions);
  const close = useTour((s) => s.close);
  const openSettings = useUi((s) => s.openSettings);
  const said = useRef(false);

  useEffect(() => (desktop ? watchNovaVoice() : undefined), [desktop]);

  // Only with NOVA's own voice: that's the one someone chose to hear.
  const prefs = agent?.prefs;
  useEffect(() => {
    if (said.current || !prefs || novaVoice?.state !== "ready") return;
    said.current = true;
    void speak(`Das war's${profile.firstName ? `, ${profile.firstName}` : ""}. Schön, dass du da bist.`, prefs, "test", true);
  }, [prefs, novaVoice?.state, profile.firstName]);

  const rows: { label: string; icon: LucideIcon; done: boolean; section?: string }[] = [
    { label: "Dein Name", icon: Check, done: displayName.trim() !== "", section: "you" },
    { label: "Deine Farbe", icon: Check, done: missions.includes("look"), section: "appearance" },
    { label: "Thorsten", icon: AudioLines, done: novaVoice?.state === "ready", section: "assistant-brain" },
    { label: "KI verbunden", icon: Sparkles, done: Object.values(keys ?? {}).some(Boolean), section: "ai" },
    { label: "Hey NOVA", icon: Ear, done: Boolean(wake?.prefs.phrase || wake?.prefs.clap), section: "wake" },
    { label: "Rundgang", icon: Check, done: missions.includes("explore") },
    { label: "Abkürzungen", icon: Check, done: missions.includes("keys") },
  ];

  return (
    <div className="relative pt-4 text-center">
      <Sparks />
      <Orb />
      <Heading title={`Fertig${profile.firstName ? `, ${profile.firstName}` : ""}!`}>Das meiste kann ich jetzt. Was noch fehlt, holst du nach, wann immer du willst.</Heading>
      <ul className="flex flex-wrap justify-center gap-1.5">
        {rows.map((row) => {
          const content = (
            <>
              {row.done ? <Check size={12} aria-hidden /> : row.section ? <ArrowRight size={12} className="text-accent-text" aria-hidden /> : <span aria-hidden className="size-1.5 rounded-full bg-white/[0.25]" />}
              {row.label}
            </>
          );
          const pill = "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px]";
          return (
            <li key={row.label}>
              {!row.done && row.section ? (
                <button
                  type="button"
                  className={cn(pill, "bg-white/[0.06] text-fg transition-colors hover:bg-white/[0.11]")}
                  onClick={() => {
                    close();
                    openSettings(row.section!);
                  }}
                >
                  {content}
                </button>
              ) : (
                <span className={cn(pill, row.done ? "bg-success/10 text-success" : "bg-white/[0.04] text-fg-subtle")}>{content}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-5 text-[12px] text-fg-subtle">
        Diese Tour findest du jederzeit wieder unter Settings → About NOVA oder mit <Keys keys={["Ctrl", "K"]} />.
      </p>
    </div>
  );
}

export const TOUR_STEPS: readonly { id: string; label: string; docked?: boolean; body: ComponentType }[] = [
  { id: "hello", label: "Hallo", body: HelloStep },
  { id: "look", label: "Dein Look", body: LookStep },
  { id: "voice", label: "Stimme", body: VoiceStep },
  { id: "ai", label: "KI", body: AiStep },
  { id: "call", label: "NOVA rufen", body: CallStep },
  { id: "explore", label: "Rundgang", docked: true, body: ExploreStep },
  { id: "keys", label: "Abkürzungen", docked: true, body: KeysStep },
  { id: "done", label: "Fertig", body: DoneStep },
];
