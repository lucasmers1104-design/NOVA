import { CalendarClock, Clock, CloudSun, Hourglass, MapPin, Newspaper, Settings2 } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { cn } from "@/lib/cn";
import { nativeStorage } from "@/lib/persistence";
import { useSettings } from "@/stores/settings";
import { RegisteredWidget } from "@/widgets/RegisteredWidget";
import { WidgetFrame } from "@/widgets/WidgetFrame";
import { placeLabel } from "./api";
import { FeedManager, NewsList, PlacePicker, WeatherCard } from "./LiveWidgets";

const CARDS = [
  { id: "weather", label: "Weather", icon: CloudSun },
  { id: "news", label: "News", icon: Newspaper },
  { id: "clocks", label: "World clocks", icon: Clock },
  { id: "progress", label: "Progress", icon: Hourglass },
  { id: "agenda", label: "Agenda", icon: CalendarClock },
] as const;
type CardId = (typeof CARDS)[number]["id"];

const useLiveLayout = create<{ hidden: CardId[]; toggle: (id: CardId) => void }>()(
  persist(
    (set) => ({
      hidden: [],
      toggle: (id) => set((s) => ({ hidden: s.hidden.includes(id) ? s.hidden.filter((h) => h !== id) : [...s.hidden, id] })),
    }),
    {
      name: "nova.live",
      storage: createJSONStorage(() => nativeStorage),
      merge: (persisted, current) => {
        const raw = (persisted as { hidden?: unknown } | null)?.hidden;
        const hidden = Array.isArray(raw) ? raw.filter((h): h is CardId => CARDS.some((c) => c.id === h)) : [];
        return { ...current, hidden };
      },
    },
  ),
);

export default function LivePage() {
  const hidden = useLiveLayout((s) => s.hidden);
  const toggle = useLiveLayout((s) => s.toggle);
  const show = (id: CardId) => !hidden.includes(id);

  return (
    <Page>
      <PageHeader title="Live Information" description="Weather, headlines and time — from sources you choose. Nothing is fetched until you set it up." />
      <div role="group" aria-label="Visible cards" className="mb-5 flex flex-wrap gap-1.5">
        {CARDS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={show(id)}
            onClick={() => toggle(id)}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] font-medium transition-colors",
              show(id) ? "accent-soft border-accent/40 text-fg" : "border-line bg-white/[0.03] text-fg-subtle hover:text-fg",
            )}
          >
            <Icon size={13} aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-12 gap-4">
        {show("weather") && (
          <div className="col-span-7 min-h-80">
            <WeatherPanel />
          </div>
        )}
        {show("news") && (
          <div className={cn("min-h-80", show("weather") ? "col-span-5 row-span-2" : "col-span-12")}>
            <NewsPanel />
          </div>
        )}
        {show("clocks") && (
          <div className="col-span-7 grid grid-cols-3 gap-4">
            {["local", "America/New_York", "Asia/Tokyo"].map((zone) => (
              <div key={zone} className="h-48">
                <RegisteredWidget id="clock" config={{ timeZone: zone }} />
              </div>
            ))}
          </div>
        )}
        {show("progress") && (
          <div className="col-span-6 h-64">
            <RegisteredWidget id="progress" />
          </div>
        )}
        {show("agenda") && (
          <div className="col-span-6 h-64">
            <RegisteredWidget id="tasks" config={{ showQuickAdd: false }} />
          </div>
        )}
      </div>
    </Page>
  );
}

function WeatherPanel() {
  const place = useSettings((s) => s.weatherPlace);
  const setPlace = useSettings((s) => s.setWeatherPlace);
  const fahrenheit = useSettings((s) => s.weatherFahrenheit);
  const setFahrenheit = useSettings((s) => s.setWeatherFahrenheit);
  const [changing, setChanging] = useState(false);

  return (
    <WidgetFrame
      title="Weather"
      icon={CloudSun}
      actions={
        place ? (
          <>
            <SegmentedControl
              label="Temperature unit"
              value={fahrenheit ? "f" : "c"}
              options={[
                { value: "c", label: "°C" },
                { value: "f", label: "°F" },
              ]}
              onChange={(v) => setFahrenheit(v === "f")}
            />
            <Button size="sm" variant="ghost" icon={<MapPin size={13} />} onClick={() => setChanging((c) => !c)} className="h-7">
              {changing ? "Cancel" : "Change"}
            </Button>
          </>
        ) : undefined
      }
    >
      {changing && place ? (
        <div>
          <p className="mb-3 text-[13px] text-fg-muted">Currently showing {placeLabel(place)}.</p>
          <PlacePicker onPicked={() => setChanging(false)} />
          <Button
            size="sm"
            variant="ghost"
            className="mt-3"
            onClick={() => {
              setPlace(null);
              setChanging(false);
            }}
          >
            Turn off weather
          </Button>
        </div>
      ) : (
        <WeatherCard />
      )}
    </WidgetFrame>
  );
}

function NewsPanel() {
  const [managing, setManaging] = useState(false);
  const feeds = useSettings((s) => s.newsFeeds);
  return (
    <WidgetFrame
      title="Headlines"
      icon={Newspaper}
      actions={
        <Button size="sm" variant="ghost" icon={<Settings2 size={13} />} onClick={() => setManaging((m) => !m)} className="h-7">
          {managing ? "Done" : "Feeds"}
        </Button>
      }
    >
      {managing || feeds.length === 0 ? (
        <div>
          <p className="mb-3 text-[13px] text-fg-muted">Add RSS or Atom feeds from sites you trust. NOVA fetches them directly; no news service sits in between.</p>
          <FeedManager />
        </div>
      ) : (
        <NewsList />
      )}
    </WidgetFrame>
  );
}
