import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { AudioLines, FolderSearch, History, Plus, RefreshCw, Trash } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { PROVIDERS, providerInfo, useModels } from "@/features/ai/api";
import { notifyError, notify } from "@/features/notifications/store";
import { SettingRow, SettingsSection } from "@/features/settings/SettingsLayout";
import { isDesktop } from "@/lib/native";
import {
  agentStatus,
  clearHistory,
  configureAgent,
  finderAddStandardFolders,
  finderPickFolder,
  finderReindex,
  finderRemoveFolder,
  finderSetContent,
  finderStatus,
} from "./api";
import { ASSISTANT_EVENTS, type AgentPrefs, type AgentStatus, type FinderStatus, type ProviderId } from "./types";
import { speak, voices } from "./voice";

const AGENT_KEY = ["assistant", "agent"] as const;
const FINDER_KEY = ["assistant", "finder"] as const;

const EFFORTS = [
  { value: "low", label: "Fast" },
  { value: "medium", label: "Balanced" },
  { value: "high", label: "Thorough" },
] as const satisfies readonly { value: AgentPrefs["effort"]; label: string }[];

const LANGUAGES = [
  { value: "auto", label: "Same as Windows" },
  { value: "de-DE", label: "Deutsch (Deutschland)" },
  { value: "de-AT", label: "Deutsch (Österreich)" },
  { value: "de-CH", label: "Deutsch (Schweiz)" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
];

const selectClass = "h-9 max-w-64 rounded-control border border-line bg-black/25 px-2.5 text-[13px] text-fg outline-none focus:border-line-strong disabled:opacity-50";

function useAgent() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: AGENT_KEY, queryFn: agentStatus, enabled: isDesktop() });
  useEffect(() => {
    if (!isDesktop()) return;
    const unlisten = listen<AgentStatus>(ASSISTANT_EVENTS.agent, (event) => client.setQueryData(AGENT_KEY, event.payload));
    return () => void unlisten.then((stop) => stop());
  }, [client]);
  const save = useMutation({
    mutationFn: configureAgent,
    onSuccess: (next) => client.setQueryData(AGENT_KEY, next),
    onError: (error) => notifyError("Couldn't save the assistant settings", error),
  });
  const update = (patch: Partial<AgentPrefs>) => {
    const current = query.data?.prefs;
    if (current) save.mutate({ ...current, ...patch });
  };
  return { status: query.data, update, saving: save.isPending };
}

/** Settings → Assistant model & voice. */
export function AgentSettings() {
  const { status, update, saving } = useAgent();
  const limitId = useId();
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const [voiceList, setVoiceList] = useState<SpeechSynthesisVoice[]>(() => voices());

  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const refresh = () => setVoiceList(voices());
    speechSynthesis.addEventListener("voiceschanged", refresh);
    refresh();
    return () => speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, []);

  if (!isDesktop()) {
    return (
      <SettingsSection id="assistant-brain" title="Assistant model & voice" description="Which AI answers and how NOVA speaks." icon={AudioLines}>
        <p className="text-[13px] text-fg-muted">Available in the NOVA desktop app.</p>
      </SettingsSection>
    );
  }

  const prefs = status?.prefs;
  const configured = PROVIDERS.filter((p) => status?.keys[p.id]);
  const chosen: ProviderId | null = prefs?.provider ?? null;
  const usage = status?.usageThisMonth;
  const spent = (usage?.costMicros ?? 0) / 1_000_000;

  return (
    <SettingsSection id="assistant-brain" title="Assistant model & voice" description="Which AI answers NOVA AI, what it may spend, and how it speaks." icon={AudioLines}>
      <SettingRow
        label="AI provider"
        description={
          status?.activeProvider
            ? `Answering now: ${status.activeProvider} · ${status.activeModel}`
            : configured.length === 0
              ? "No provider connected — NOVA AI only understands local commands (find files, open apps). Add a key under AI providers."
              : "Choose a model for this provider below."
        }
      >
        <select
          aria-label="AI provider"
          className={selectClass}
          disabled={!prefs || saving}
          value={chosen ?? "auto"}
          onChange={(e) => update({ provider: e.target.value === "auto" ? null : (e.target.value as ProviderId) })}
        >
          <option value="auto">Automatic (first connected)</option>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id} disabled={!status?.keys[p.id]}>
              {p.name}
              {status?.keys[p.id] ? "" : " — no key"}
            </option>
          ))}
        </select>
      </SettingRow>
      {PROVIDERS.filter((p) => status?.keys[p.id] || p.id === "anthropic").map((p) => (
        <ModelRow
          key={p.id}
          provider={p.id}
          name={p.name}
          hasKey={status?.keys[p.id] ?? false}
          value={prefs?.models[p.id] ?? ""}
          disabled={!prefs || saving}
          onChange={(model) => {
            const models = { ...prefs?.models };
            if (model) models[p.id] = model;
            else delete models[p.id];
            update({ models });
          }}
        />
      ))}
      <SettingRow label="Thoroughness" description="Fast answers sooner; Thorough thinks longer on hard requests (Claude models).">
        <SegmentedControl label="Thoroughness" value={prefs?.effort ?? "medium"} options={EFFORTS} onChange={(effort) => update({ effort })} />
      </SettingRow>
      <SettingRow
        label="Monthly limit"
        htmlFor={limitId}
        description={
          <>
            This month: {usage?.requests ?? 0} requests · {((usage?.inputTokens ?? 0) / 1000).toFixed(1)}k in · {((usage?.outputTokens ?? 0) / 1000).toFixed(1)}k out
            {spent > 0 && ` · ≈ $${spent.toFixed(2)}`}
            {(usage?.unpricedRequests ?? 0) > 0 && ` · ${usage?.unpricedRequests} without a price estimate`}. Costs are estimates for Claude models; your provider's bill is authoritative.
          </>
        }
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] text-fg-muted">$</span>
          <input
            id={limitId}
            inputMode="decimal"
            placeholder="No limit"
            value={limitDraft ?? (prefs?.monthlyLimitUsd != null ? String(prefs.monthlyLimitUsd) : "")}
            onChange={(e) => setLimitDraft(e.target.value)}
            onBlur={() => {
              if (limitDraft === null) return;
              const value = limitDraft.trim().replace(",", ".");
              const limit = value === "" ? null : Number(value);
              setLimitDraft(null);
              if (limit === null || (Number.isFinite(limit) && limit >= 0)) update({ monthlyLimitUsd: limit });
              else notify("Enter a positive amount, or leave it empty for no limit", { kind: "warning" });
            }}
            className="h-9 w-24 rounded-control border border-line bg-black/25 px-2.5 text-[13px] text-fg outline-none select-text focus:border-line-strong"
          />
        </div>
      </SettingRow>
      <SettingRow label="Spoken replies" description="NOVA reads its answers aloud. Replies to spoken questions are always read aloud.">
        <Switch label="Spoken replies" checked={prefs?.speakReplies ?? false} disabled={!prefs} onChange={(speakReplies) => update({ speakReplies })} />
      </SettingRow>
      <SettingRow label="Voice" description={voiceList.length === 0 ? "No Windows voices found. Add one in Windows Settings → Time & language → Speech." : "Windows voices installed on this PC."}>
        <div className="flex items-center gap-1.5">
          <select aria-label="Voice" className={selectClass} disabled={!prefs || voiceList.length === 0} value={prefs?.voice ?? ""} onChange={(e) => update({ voice: e.target.value })}>
            <option value="">Automatic (matches the reply's language)</option>
            {voiceList.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="ghost"
            disabled={!prefs || voiceList.length === 0}
            onClick={() => prefs && void speak(/^de/i.test(voiceList.find((v) => v.name === prefs.voice)?.lang ?? navigator.language) ? "Hallo, ich bin NOVA. So klinge ich." : "Hi, I'm NOVA. This is how I sound.", prefs)}
          >
            Test
          </Button>
        </div>
      </SettingRow>
      <SettingRow label="Speed and volume">
        <div className="flex items-center gap-3 text-[12px] text-fg-muted">
          <label className="flex items-center gap-2">
            Speed
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={prefs?.speechRate ?? 1}
              onChange={(e) => update({ speechRate: Number(e.target.value) })}
              className="nova-range w-24"
              style={{ "--range-fill": `${(((prefs?.speechRate ?? 1) - 0.5) / 1.5) * 100}%` } as React.CSSProperties}
            />
          </label>
          <label className="flex items-center gap-2">
            Volume
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={prefs?.speechVolume ?? 1}
              onChange={(e) => update({ speechVolume: Number(e.target.value) })}
              className="nova-range w-24"
              style={{ "--range-fill": `${(prefs?.speechVolume ?? 1) * 100}%` } as React.CSSProperties}
            />
          </label>
        </div>
      </SettingRow>
      <SettingRow label="Speech recognition language" description="Push-to-talk uses Windows speech recognition. Dictation may need “Online speech recognition” in Windows Settings → Privacy → Speech.">
        <select aria-label="Speech recognition language" className={selectClass} disabled={!prefs} value={prefs?.language ?? "auto"} onChange={(e) => update({ language: e.target.value })}>
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </SettingRow>
    </SettingsSection>
  );
}

function ModelRow({ provider, name, hasKey, value, disabled, onChange }: { provider: ProviderId; name: string; hasKey: boolean; value: string; disabled: boolean; onChange: (model: string) => void }) {
  const { data: models, isLoading, error } = useModels(provider, hasKey);
  // Without a key the suggested models are offered, so the choice can be made up front.
  const list = models ?? providerInfo(provider).suggestedModels.map((id) => ({ id, name: id }));
  return (
    <SettingRow
      label={`${name} model`}
      description={error ? `Couldn't load models: ${error instanceof Error ? error.message : String(error)}` : value ? undefined : "Follows the model chosen in the NOVA AI tab."}
    >
      <select aria-label={`${name} model`} className={selectClass} disabled={disabled || isLoading} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Same as the NOVA AI tab</option>
        {value && !list.some((m) => m.id === value) && <option value={value}>{value}</option>}
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

/** Settings → NOVA Finder. */
export function FinderSettings() {
  const client = useQueryClient();
  const desktop = isDesktop();
  const { data: status } = useQuery({ queryKey: FINDER_KEY, queryFn: finderStatus, enabled: desktop });
  const set = (next: FinderStatus) => client.setQueryData(FINDER_KEY, next);
  const run = (action: () => Promise<FinderStatus>, failure: string) => void action().then(set, (e: unknown) => notifyError(failure, e));

  useEffect(() => {
    if (!desktop) return;
    const unlisten = listen(ASSISTANT_EVENTS.finder, () => void client.invalidateQueries({ queryKey: FINDER_KEY }));
    return () => void unlisten.then((stop) => stop());
  }, [client, desktop]);

  const progress = status?.progress;
  const total = status?.folders.reduce((s, f) => s + f.files, 0) ?? 0;
  return (
    <SettingsSection id="finder" title="NOVA Finder" description="The folders NOVA AI searches. The index stays on this PC; nothing is indexed until you add a folder." icon={FolderSearch}>
      {!desktop ? (
        <p className="text-[13px] text-fg-muted">Available in the NOVA desktop app.</p>
      ) : (
        <>
          <div className="pb-4">
            {status?.folders.length === 0 && <p className="text-[13px] text-fg-muted">No folders yet. Searches only scan file names in your standard folders.</p>}
            <ul className="space-y-1">
              {status?.folders.map((folder) => (
                <li key={folder.path} className="flex items-center gap-3 rounded-[12px] border border-line bg-white/[0.025] px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-fg">{folder.path}</span>
                    <span className="text-[11.5px] text-fg-subtle">{folder.exists ? `${folder.files.toLocaleString()} items indexed` : "Folder not found"}</span>
                  </span>
                  <IconButton label={`Stop indexing ${folder.path}`} size="sm" onClick={() => run(() => finderRemoveFolder(folder.path), "Couldn't remove the folder")}>
                    <Trash size={14} aria-hidden />
                  </IconButton>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={<Plus size={14} aria-hidden />} onClick={() => run(finderPickFolder, "Couldn't add the folder")}>
                Add folder…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => run(finderAddStandardFolders, "Couldn't add the folders")}>
                Add Documents, Desktop, Downloads & more
              </Button>
              {(status?.folders.length ?? 0) > 0 && (
                <Button size="sm" variant="ghost" icon={<RefreshCw size={13} aria-hidden />} disabled={progress?.running} onClick={() => run(finderReindex, "Couldn't start indexing")}>
                  Refresh index
                </Button>
              )}
            </div>
            <p className="mt-2 text-[12px] text-fg-muted" aria-live="polite">
              {progress?.running
                ? `Indexing… ${progress.scanned.toLocaleString()} items checked${progress.current ? ` in ${progress.current}` : ""}`
                : progress?.error
                  ? `Last indexing failed: ${progress.error}`
                  : total > 0
                    ? `${total.toLocaleString()} items indexed${progress?.lastFinished ? ` · updated ${new Date(progress.lastFinished).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}` : ""}. NOVA refreshes the index in the background.`
                    : null}
            </p>
          </div>
          <SettingRow label="Search inside text files" description="Also indexes the beginning of text files (.txt, .md, .csv, code…) so NOVA can find them by content. Turning it off deletes the stored text.">
            <Switch label="Search inside text files" checked={status?.content ?? true} disabled={!status} onChange={(enabled) => run(() => finderSetContent(enabled), "Couldn't change the setting")} />
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}

/** Clears NOVA AI's action log and usage records. */
export function AssistantHistoryRow() {
  const [confirming, setConfirming] = useState(false);
  const client = useQueryClient();
  if (!isDesktop()) return null;
  return (
    <>
      <SettingRow label="Action history and usage" description="NOVA AI logs what it did (searches, opened items, documents, file changes, screenshots) and its token usage, locally. Conversations are never stored.">
        <Button size="sm" variant="secondary" icon={<History size={14} aria-hidden />} onClick={() => setConfirming(true)}>
          Clear
        </Button>
      </SettingRow>
      <ConfirmDialog
        open={confirming}
        title="Clear NOVA AI history?"
        description="Deletes the action log and usage records on this PC. This can't be undone."
        confirmLabel="Clear history"
        danger
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void clearHistory().then(
            () => {
              void client.invalidateQueries({ queryKey: AGENT_KEY });
              notify("NOVA AI history cleared", { kind: "success" });
            },
            (e: unknown) => notifyError("Couldn't clear the history", e),
          );
        }}
      />
    </>
  );
}
