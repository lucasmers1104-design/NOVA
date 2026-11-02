import { ArrowRight, Plus, Puzzle, Search, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useActiveLayout, useDashboard } from "@/features/dashboard/store";
import { FieldRow } from "@/features/home/WidgetSettingsDialog";
import { notify } from "@/features/notifications/store";
import { cn } from "@/lib/cn";
import { useUi } from "@/stores/ui";
import { resolveConfig } from "@/widgets/config";
import { RegisteredWidget } from "@/widgets/RegisteredWidget";
import { WIDGETS } from "@/widgets/registry";
import { CATEGORY_LABELS, type WidgetCategory } from "@/widgets/types";

const SOURCE_LABEL = { local: "Local only", system: "System data", network: "Uses internet" } as const;
const ROW = 96;
const GAP = 16;

export default function WidgetStudioPage() {
  const layout = useActiveLayout();
  const addWidget = useDashboard((s) => s.addWidget);
  const updateWidgetConfig = useDashboard((s) => s.updateWidgetConfig);
  const navigate = useUi((s) => s.navigate);
  const [category, setCategory] = useState<WidgetCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(WIDGETS[0]!.id);
  const [configs, setConfigs] = useState<Record<string, Record<string, unknown>>>({});

  const categories = useMemo(() => [...new Set(WIDGETS.map((w) => w.category))], []);
  const visible = WIDGETS.filter(
    (w) =>
      (category === "all" || w.category === category) &&
      (!query.trim() || `${w.name} ${w.description}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const selected = WIDGETS.find((w) => w.id === selectedId) ?? WIDGETS[0]!;
  const config = configs[selected.id] ?? {};
  const resolved = resolveConfig(selected.configSchema, config);

  const add = () => {
    const id = addWidget(selected.id);
    if (!id) return;
    if (Object.keys(config).length) updateWidgetConfig(id, config);
    notify(`${selected.name} added to “${layout?.name ?? "your dashboard"}”`, { kind: "success" });
  };

  return (
    <Page>
      <PageHeader
        title="Widget Studio"
        description="Browse every widget, preview it live with your settings, and add it to your dashboard."
        actions={
          <Button size="sm" variant="secondary" icon={<ArrowRight size={14} />} onClick={() => navigate("home")}>
            Go to dashboard
          </Button>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)_440px] items-start gap-6">
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <label className="glass flex h-10 w-64 items-center gap-2 rounded-full px-4 focus-within:border-line-strong">
              <Search size={15} className="text-fg-subtle" aria-hidden />
              <span className="sr-only">Search widgets</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search widgets" className="h-full flex-1 bg-transparent text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle" />
            </label>
            {(["all", ...categories] as const).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                className={cn(
                  "h-8 rounded-full border px-3.5 text-[12.5px] font-medium transition-colors",
                  category === c ? "accent-soft border-accent/40 text-fg" : "border-line bg-white/[0.03] text-fg-muted hover:text-fg",
                )}
              >
                {c === "all" ? "All" : CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          <ul className="grid grid-cols-2 gap-3">
            {visible.map((widget) => {
              const Icon = widget.icon;
              const count = layout?.widgets.filter((w) => w.widgetId === widget.id).length ?? 0;
              return (
                <li key={widget.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(widget.id)}
                    aria-pressed={selected.id === widget.id}
                    className={cn(
                      "glass flex h-full w-full items-start gap-3.5 rounded-[18px] p-4 text-left transition-[background-color,border-color,transform] duration-200 hover:-translate-y-0.5",
                      selected.id === widget.id ? "border-accent/50 bg-white/[0.07]" : "hover:bg-white/[0.05]",
                    )}
                  >
                    <span className="accent-gradient flex size-11 shrink-0 items-center justify-center rounded-[13px] text-on-accent shadow-[0_8px_20px_-8px_var(--nova-accent-glow)]">
                      <Icon size={20} aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-semibold text-fg">{widget.name}</span>
                      <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-muted">{widget.description}</span>
                      <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-subtle">
                        <span>{CATEGORY_LABELS[widget.category]}</span>
                        <span>{SOURCE_LABEL[widget.dataSource]}</span>
                        {count > 0 && <span className="text-accent-text">On dashboard{count > 1 ? ` ×${count}` : ""}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <aside className="glass mt-6 flex items-start gap-3.5 rounded-[18px] p-5">
            <Puzzle size={20} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
            <div>
              <p className="text-[14px] font-semibold text-fg">Third-party widgets</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
                NOVA currently runs only its own trusted widgets. Community widgets will come through a plugin API with explicit permissions per widget
                and isolation from the rest of the app — never as unrestricted scripts.
              </p>
            </div>
          </aside>
        </div>

        <section aria-label={`${selected.name} preview`} className="sticky top-0">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-fg">{selected.name}</h2>
            <Badge tone={selected.dataSource === "network" ? "warning" : "neutral"}>
              {selected.dataSource === "network" ? <ShieldCheck size={12} aria-hidden /> : null}
              {SOURCE_LABEL[selected.dataSource]}
            </Badge>
          </div>
          <div
            inert
            className="pointer-events-none mx-auto"
            style={{ height: selected.defaultSize.h * ROW + (selected.defaultSize.h - 1) * GAP, maxWidth: selected.defaultSize.w >= 8 ? "100%" : 440 }}
            aria-hidden
          >
            <RegisteredWidget key={`${selected.id}-${JSON.stringify(resolved)}`} id={selected.id} config={config} />
          </div>
          <div className="glass mt-4 rounded-[18px] p-5">
            {selected.configSchema.length === 0 ? (
              <p className="text-[13px] text-fg-muted">This widget has no settings.</p>
            ) : (
              <div className="divide-y divide-line">
                {selected.configSchema.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    value={resolved[field.key]}
                    onChange={(value) => setConfigs((all) => ({ ...all, [selected.id]: { ...all[selected.id], [field.key]: value } }))}
                  />
                ))}
              </div>
            )}
            <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
              <p className="text-[12px] text-fg-subtle tabular-nums">
                Default size {selected.defaultSize.w} × {selected.defaultSize.h} · resizable {selected.minSize.w}–{selected.maxSize.w} wide
              </p>
              <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={add} disabled={!layout}>
                Add to “{layout?.name ?? "Dashboard"}”
              </Button>
            </div>
          </div>
        </section>
      </div>
    </Page>
  );
}
