import {
  AppWindow,
  Box,
  Check,
  ChevronDown,
  ClipboardList,
  CloudSun,
  Copy,
  Cpu,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  Globe,
  HardDrive,
  Keyboard,
  ListChecks,
  type LucideIcon,
  MessageSquareText,
  Music2,
  Power,
  Presentation,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Timer,
  Trash2,
  Type,
  Wifi,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { openNova, openPath, openWebPage } from "../api";
import { FinderHintCard, GameCard, MusicCard, PowerCard, SpeedCard, SystemCard, TimerCard, WeatherCard } from "./NovaResultCards";
import type { ToolItem } from "../conversation";
import type { FileHit, ToolCard } from "../types";

const KIND_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  pdf: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  "3d": Box,
  code: FileCode,
  program: AppWindow,
};

export function formatSize(bytes: number): string {
  if (bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDate(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1 && date.getDate() === new Date().getDate()) return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

/** Search results, numbered so "open the second one" works. */
export function NovaFileResults({ hits, source }: { hits: FileHit[]; source: "index" | "live" }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const visible = expanded ? hits : hits.slice(0, 5);
  if (hits.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      <ol aria-label="Search results" className="space-y-1">
        {visible.map((hit, index) => {
          const Icon = KIND_ICONS[hit.kind] ?? File;
          return (
            <li key={hit.path} className="group flex items-center gap-2.5 rounded-[11px] border border-transparent px-2 py-1.5 hover:border-line hover:bg-white/[0.04]">
              <span className="w-4 shrink-0 text-right text-[11px] font-medium text-fg-subtle tabular-nums">{index + 1}</span>
              <Icon size={16} className="shrink-0 text-accent-text" aria-hidden />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void openPath(hit.path)} title={hit.path}>
                <span className="block truncate text-[12.5px] font-medium text-fg">{hit.name}</span>
                <span className="block truncate text-[11px] text-fg-subtle">
                  {[hit.folder.split("\\").slice(-2).join("\\"), formatDate(hit.modified), hit.kind !== "folder" ? formatSize(hit.size) : ""].filter(Boolean).join(" · ")}
                </span>
                {hit.snippet && <span className="mt-0.5 block truncate text-[11px] text-fg-muted italic">“{hit.snippet}”</span>}
              </button>
              <span className="flex shrink-0 gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <CardIcon label={`Open ${hit.name}`} onClick={() => void openPath(hit.path)}>
                  <ExternalLink size={13} aria-hidden />
                </CardIcon>
                <CardIcon label="Show in folder" onClick={() => void openPath(hit.path, true)}>
                  <FolderOpen size={13} aria-hidden />
                </CardIcon>
                <CardIcon
                  label={copied === hit.path ? "Path copied" : "Copy path"}
                  onClick={() => {
                    void navigator.clipboard?.writeText(hit.path).then(() => setCopied(hit.path));
                  }}
                >
                  {copied === hit.path ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                </CardIcon>
              </span>
            </li>
          );
        })}
      </ol>
      {hits.length > 5 && (
        <button type="button" className="ml-8 text-[11.5px] font-medium text-accent-text hover:underline" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show fewer" : `Show all ${hits.length}`}
        </button>
      )}
      {source === "live" && <p className="ml-8 text-[11px] text-fg-subtle">Names only — NOVA Finder isn't indexing any folders yet.</p>}
    </div>
  );
}

function CardIcon({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex size-6 items-center justify-center rounded-full text-fg-muted hover:bg-white/[0.08] hover:text-fg">
      {children}
    </button>
  );
}

function fileName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

/** Open, show in folder, copy path and copy name, for any file or folder NOVA AI mentions. */
function PathActions({ path, size = 13 }: { path: string; size?: number }) {
  const [copied, setCopied] = useState<"path" | "name" | null>(null);
  const copy = (what: "path" | "name") => {
    void navigator.clipboard?.writeText(what === "path" ? path : fileName(path)).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    });
  };
  return (
    <span className="inline-flex shrink-0 gap-0.5 align-middle">
      <CardIcon label={`Open ${fileName(path)}`} onClick={() => void openPath(path)}>
        <ExternalLink size={size} aria-hidden />
      </CardIcon>
      <CardIcon label="Show in folder" onClick={() => void openPath(path, true)}>
        <FolderOpen size={size} aria-hidden />
      </CardIcon>
      <CardIcon label={copied === "path" ? "Path copied" : "Copy path"} onClick={() => copy("path")}>
        {copied === "path" ? <Check size={size} aria-hidden /> : <Copy size={size} aria-hidden />}
      </CardIcon>
      <CardIcon label={copied === "name" ? "Name copied" : "Copy name"} onClick={() => copy("name")}>
        {copied === "name" ? <Check size={size} aria-hidden /> : <Type size={size} aria-hidden />}
      </CardIcon>
    </span>
  );
}

const WINDOWS_PATH = /^(?:[A-Za-z]:\\|\\\\[^\\]+\\)/;

/** `C:\…` in a reply becomes a chip: click opens it, the icons do the rest. */
export function renderPathCode(code: string): ReactNode | null {
  if (!WINDOWS_PATH.test(code)) return null;
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-[7px] bg-white/[0.08] py-0.5 pr-0.5 pl-1.5 align-middle">
      <button type="button" title={`Open ${code}`} onClick={() => void openPath(code)} className="min-w-0 truncate font-mono text-[0.88em] text-fg hover:text-accent-text">
        {code}
      </button>
      <PathActions path={code} size={12} />
    </span>
  );
}

function ResultCard({ card }: { card: ToolCard }) {
  switch (card.kind) {
    case "files":
      return <NovaFileResults hits={card.hits} source={card.source} />;
    case "document":
      return (
        <div className="mt-2 flex items-center gap-3 rounded-[12px] border border-line bg-white/[0.035] p-2.5">
          <span className="flex size-9 items-center justify-center rounded-[10px] accent-soft text-accent-text">
            <FileText size={17} aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-fg">{card.document.name}</span>
            <span className="block truncate text-[11px] text-fg-subtle">
              {card.document.folder} · {formatSize(card.document.size)}
            </span>
          </span>
          <PathActions path={card.document.path} size={14} />
        </div>
      );
    case "screenshot":
      return <img src={card.dataUrl} alt={`Screenshot of ${card.label}`} className="mt-2 max-h-40 rounded-[10px] border border-line object-contain" />;
    case "path":
      return (
        <div className="mt-1 flex items-center gap-2 pl-9">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-subtle" title={card.path}>
            {card.path}
          </span>
          <PathActions path={card.path} />
        </div>
      );
    case "link":
      return (
        <button type="button" title={card.url} className="mt-1 ml-9 flex max-w-[calc(100%-2.25rem)] items-center gap-1.5 text-[11.5px] font-medium text-accent-text hover:underline" onClick={() => void openWebPage(card.url)}>
          <Globe size={12} className="shrink-0" aria-hidden />
          <span className="truncate">{new URL(card.url).host}</span>
        </button>
      );
    case "productivity":
      return (
        <div className="mt-1.5 ml-9 flex items-center gap-2.5 rounded-[12px] border border-line bg-white/[0.035] px-2.5 py-2">
          <ListChecks size={15} className="shrink-0 text-accent-text" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-fg">{card.label}</span>
            {card.detail && <span className="block truncate text-[11px] text-fg-subtle">{card.detail}</span>}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void openNova("productivity")}>
            Open
          </Button>
        </div>
      );
    case "freed":
      return <FreedCard card={card} />;
    case "music":
      return <MusicCard card={card} />;
    case "game":
      return <GameCard card={card} />;
    case "timer":
      return <TimerCard card={card} />;
    case "weather":
      return <WeatherCard card={card} />;
    case "speed":
      return <SpeedCard card={card} />;
    case "system":
      return <SystemCard card={card} />;
    case "power":
      return <PowerCard card={card} />;
    case "finderHint":
      return <FinderHintCard />;
    case "app":
      return null;
  }
}

/** Counts from 0 to `target` when it appears. */
function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const reduced = document.documentElement.dataset.motion === "reduced" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setValue(target);
      return;
    }
    const started = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - started) / durationMs);
      // Quick at first, settling on the number.
      setValue(Math.round(target * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);
  return value;
}

/** How much space NOVA won, what went, and what's free now. */
export function FreedCard({ card }: { card: Extract<ToolCard, { kind: "freed" }> }) {
  const shown = useCountUp(card.bytes);
  return (
    <div className="mt-2 ml-9 rounded-[14px] border border-success/30 bg-success/[0.07] p-3">
      <div className="flex items-center gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-success/15 text-success">
          <HardDrive size={17} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[20px] leading-tight font-semibold text-fg tabular-nums" aria-label={`${formatSize(card.bytes)} free again`}>
            {formatSize(shown)}
          </span>
          <span className="block text-[11px] text-fg-muted">free again · {formatSize(card.freeNow)} free now</span>
        </span>
      </div>
      {card.items.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-line pt-2">
          {card.items.map((item) => (
            <li key={item.label} className="flex justify-between gap-3 text-[11.5px] text-fg-muted">
              <span className="min-w-0 truncate">{item.label}</span>
              <span className="shrink-0 tabular-nums">{formatSize(item.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What each kind of action looks like, so a row of steps reads at a glance. */
const TOOL_ICONS: Record<string, LucideIcon> = {
  search_files: Search,
  open_file: FolderOpen,
  show_in_folder: FolderOpen,
  list_folder: Folder,
  open_app: AppWindow,
  open_website: Globe,
  search_web_in_browser: Globe,
  read_webpage: Globe,
  system_info: Cpu,
  task_manager: Cpu,
  end_process: X,
  installed_programs: HardDrive,
  look_at_screen: AppWindow,
  list_windows: AppWindow,
  window_action: AppWindow,
  read_window: AppWindow,
  send_input: Keyboard,
  use_element: Keyboard,
  create_document: FileText,
  create_folder: FolderPlus,
  move_item: FolderOpen,
  rename_item: Type,
  delete_item: Trash2,
  list_tasks: ListChecks,
  add_task: ListChecks,
  complete_task: ListChecks,
  add_note: MessageSquareText,
  add_project: ListChecks,
  media_control: Music2,
  now_playing: Music2,
  search_on_spotify: Music2,
  spotify_play: Music2,
  spotify_library: Music2,
  spotify_control: Music2,
  game_settings: Gamepad2,
  change_game_settings: Gamepad2,
  start_game: Gamepad2,
  virus_scan: ShieldCheck,
  find_junk: HardDrive,
  clean_up: HardDrive,
  uninstall_program: Trash2,
  timer: Timer,
  weather: CloudSun,
  internet_speed: Wifi,
  power: Power,
  clipboard: ClipboardList,
};

/** The action's icon, with a ring while it runs and a mark when it's over. */
function StepIcon({ tool }: { tool: ToolItem }) {
  const Icon = TOOL_ICONS[tool.name] ?? Sparkles;
  const high = tool.risk === "high";
  const tone = {
    running: "bg-accent/15 text-accent-text",
    confirm: high ? "bg-danger/15 text-danger" : "bg-warning/15 text-warning",
    done: "bg-white/[0.07] text-fg-muted",
    failed: "bg-danger/15 text-danger",
    declined: "bg-white/[0.05] text-fg-subtle",
  }[tool.state];
  return (
    <span className={cn("relative flex size-[26px] shrink-0 items-center justify-center rounded-full", tone)}>
      {tool.state === "confirm" ? high ? <ShieldAlert size={14} aria-hidden /> : <ShieldQuestion size={14} aria-hidden /> : <Icon size={14} aria-hidden />}
      {tool.state === "running" && <span className="absolute inset-0 animate-spin rounded-full border-[1.5px] border-accent/25 border-t-accent-text" aria-hidden />}
      {tool.state === "done" && (
        <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 520, damping: 22 }} className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full bg-success text-[#08130d] ring-2 ring-[#151a29]">
          <Check size={9} strokeWidth={3.5} aria-hidden />
        </motion.span>
      )}
      {(tool.state === "failed" || tool.state === "declined") && (
        <span className={cn("absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full ring-2 ring-[#151a29]", tool.state === "failed" ? "bg-danger text-white" : "bg-fg-subtle text-[#151a29]")}>
          <X size={9} strokeWidth={3.5} aria-hidden />
        </span>
      )}
    </span>
  );
}

interface NovaToolCardProps {
  tool: ToolItem;
  onConfirm: (approved: boolean) => void;
}

/** Several steps in a row: one card, with how far along it is; finished long ones fold away. */
export function NovaToolSteps({ tools, onConfirm }: { tools: ToolItem[]; onConfirm: (id: string, approved: boolean) => void }) {
  const finished = tools.filter((t) => t.state === "done").length;
  const over = tools.every((t) => t.state !== "running" && t.state !== "confirm");
  const [open, setOpen] = useState(false);
  if (tools.length === 1) return <NovaToolCard tool={tools[0]!} onConfirm={(approved) => onConfirm(tools[0]!.id, approved)} />;
  const folds = over && tools.length > 2 && tools.every((t) => !t.card);
  const shown = !folds || open;
  return (
    <div className="my-2 rounded-[14px] border border-line bg-white/[0.025] px-2.5 py-1.5">
      <button type="button" disabled={!folds} aria-expanded={folds ? open : undefined} onClick={() => setOpen((now) => !now)} className="flex w-full items-center gap-2 py-1 text-left text-[11.5px] text-fg-muted">
        <span className="font-medium tabular-nums">
          {finished}/{tools.length}
        </span>
        <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
          <motion.span className="block h-full rounded-full bg-accent-text" initial={false} animate={{ width: `${(finished / tools.length) * 100}%` }} transition={{ duration: 0.3 }} />
        </span>
        {folds && <ChevronDown size={13} className={cn("shrink-0 transition-transform", open && "rotate-180")} aria-hidden />}
      </button>
      {shown && tools.map((tool) => <NovaToolCard key={tool.id} tool={tool} onConfirm={(approved) => onConfirm(tool.id, approved)} />)}
    </div>
  );
}

/** One action NOVA AI takes: its progress, the user's confirmation, and the result. */
export function NovaToolCard({ tool, onConfirm }: NovaToolCardProps) {
  const high = tool.risk === "high";
  const stateLabel = { running: "In progress", confirm: "Needs your OK", done: "Done", failed: "Failed", declined: "Not allowed" }[tool.state];

  return (
    <div
      role={tool.state === "confirm" ? "alertdialog" : "group"}
      aria-label={`${tool.title} — ${stateLabel}`}
      className={cn(
        "my-2",
        tool.state === "confirm" && "rounded-[14px] border p-3",
        tool.state === "confirm" && (high ? "border-danger/40 bg-danger/[0.06]" : "border-warning/35 bg-warning/[0.05]"),
      )}
    >
      <div className="flex items-center gap-2.5">
        <StepIcon tool={tool} />
        <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
          <span className={cn("text-fg", tool.state === "confirm" && "font-medium")}>{tool.title}</span>
          {tool.summary && tool.summary !== tool.title && tool.state !== "confirm" && (
            <>
              <span className="text-fg-subtle" aria-hidden>
                {" · "}
              </span>
              <span className={tool.state === "failed" ? "text-danger" : "text-fg-muted"}>{tool.summary}</span>
            </>
          )}
        </p>
      </div>
      {tool.state === "confirm" && (
        <div className="mt-1.5 pl-9">
          {tool.detail && <p className="text-[11.5px] leading-relaxed text-fg-muted">{tool.detail}</p>}
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" variant={high ? "danger" : "primary"} onClick={() => onConfirm(true)}>
              {high ? "Yes, do it" : "Allow"}
            </Button>
            {/* Focus on the safe answer: someone typing a follow-up mustn't approve this with Space or Enter. */}
            <Button size="sm" variant="ghost" onClick={() => onConfirm(false)} autoFocus>
              Not now
            </Button>
          </div>
        </div>
      )}
      {tool.card && <ResultCard card={tool.card} />}
    </div>
  );
}
