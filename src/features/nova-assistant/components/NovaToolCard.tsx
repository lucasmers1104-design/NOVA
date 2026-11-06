import {
  AppWindow,
  Box,
  Check,
  Copy,
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
  Globe,
  ListChecks,
  Loader2,
  type LucideIcon,
  Presentation,
  ShieldAlert,
  ShieldQuestion,
  Type,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { openNova, openPath, openWebPage } from "../api";
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
        <div className="mt-1 flex items-center gap-2 pl-6">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-subtle" title={card.path}>
            {card.path}
          </span>
          <PathActions path={card.path} />
        </div>
      );
    case "link":
      return (
        <button type="button" title={card.url} className="mt-1 ml-6 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 text-[11.5px] font-medium text-accent-text hover:underline" onClick={() => void openWebPage(card.url)}>
          <Globe size={12} className="shrink-0" aria-hidden />
          <span className="truncate">{new URL(card.url).host}</span>
        </button>
      );
    case "productivity":
      return (
        <div className="mt-1.5 ml-6 flex items-center gap-2.5 rounded-[12px] border border-line bg-white/[0.035] px-2.5 py-2">
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
    case "app":
      return null;
  }
}

interface NovaToolCardProps {
  tool: ToolItem;
  onConfirm: (approved: boolean) => void;
}

/** One action NOVA AI takes: its progress, the user's confirmation, and the result. */
export function NovaToolCard({ tool, onConfirm }: NovaToolCardProps) {
  const high = tool.risk === "high";
  const icon = {
    running: <Loader2 size={14} className="animate-spin text-accent-text" aria-hidden />,
    confirm: high ? <ShieldAlert size={14} className="text-danger" aria-hidden /> : <ShieldQuestion size={14} className="text-warning" aria-hidden />,
    done: <Check size={14} className="text-success" aria-hidden />,
    failed: <X size={14} className="text-danger" aria-hidden />,
    declined: <X size={14} className="text-fg-subtle" aria-hidden />,
  }[tool.state];
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
      <div className="flex items-start gap-2">
        <span className="mt-[3px] shrink-0">{icon}</span>
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
        <div className="mt-1.5 pl-6">
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
