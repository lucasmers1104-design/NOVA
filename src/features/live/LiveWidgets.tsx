import { Droplets, MapPin, Newspaper, Plus, Search, Sunrise, Sunset, Trash, Wind } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { notify, notifyError } from "@/features/notifications/store";
import { uiLocale } from "@/lib/time";
import { MAX_NEWS_FEEDS, useSettings, type WeatherPlace } from "@/stores/settings";
import { describeWeather, fetchFeed, mergeFeeds, openLink, placeLabel, searchPlaces, useFeeds, useForecast } from "./api";

/** City search that sets the weather location. */
export function PlacePicker({ onPicked }: { onPicked?: () => void }) {
  const setPlace = useSettings((s) => s.setWeatherPlace);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WeatherPlace[] | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setBusy(true);
    try {
      setResults(await searchPlaces(query));
    } catch (error) {
      notifyError("Couldn't search places", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <form onSubmit={search} className="flex gap-2">
        <label className="flex h-10 flex-1 items-center gap-2 rounded-control border border-line bg-black/25 px-3 focus-within:border-line-strong">
          <Search size={15} className="text-fg-subtle" aria-hidden />
          <span className="sr-only">City</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for a city" className="h-full flex-1 bg-transparent text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle" />
        </label>
        <Button type="submit" size="md" variant="secondary" disabled={busy || query.trim().length < 2}>
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>
      {results && (
        <ul className="mt-2 space-y-1">
          {results.length === 0 && <li className="px-2 py-2 text-[13px] text-fg-muted">No places found.</li>}
          {results.map((place) => (
            <li key={`${place.latitude},${place.longitude}`}>
              <button
                type="button"
                onClick={() => {
                  setPlace(place);
                  setResults(null);
                  setQuery("");
                  onPicked?.();
                }}
                className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13px] text-fg hover:bg-white/[0.06]"
              >
                <MapPin size={14} className="text-accent-text" aria-hidden />
                {placeLabel(place)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11.5px] text-fg-subtle">Weather comes from Open-Meteo. Only the chosen place's coordinates are sent; no account or key is needed.</p>
    </div>
  );
}

export function WeatherCard({ compact = false }: { compact?: boolean }) {
  const place = useSettings((s) => s.weatherPlace);
  const { data, error, isPending, refetch } = useForecast();
  const locale = uiLocale();

  if (!place) {
    return compact ? (
      <p className="flex h-full items-center justify-center text-center text-[13px] text-fg-muted">Choose a location in Live Information to see the weather.</p>
    ) : (
      <PlacePicker />
    );
  }
  if (error) return <StatusMessage error={error} subject="the weather" onRetry={() => void refetch()} compact={compact} />;
  if (isPending) return <Skeleton className="h-full min-h-24" />;

  const now = describeWeather(data.current.weatherCode, data.current.isDay);
  const Icon = now.icon;
  const unit = data.temperatureUnit;
  const days = data.daily.slice(compact ? 1 : 0, compact ? 4 : 6);
  const today = data.daily[0];
  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : "—");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-[12px] text-fg-subtle">{placeLabel(place)}</p>
          <p className="mt-1 flex items-baseline gap-1">
            <span className={compact ? "text-[38px] leading-none font-light text-fg tabular-nums" : "text-[56px] leading-none font-extralight text-fg tabular-nums"}>
              {Math.round(data.current.temperature)}°
            </span>
          </p>
          <p className="mt-1 text-[13px] text-fg-muted">
            {now.label} · feels {Math.round(data.current.apparentTemperature)}°
          </p>
        </div>
        <Icon size={compact ? 40 : 64} strokeWidth={1.4} className="shrink-0 text-accent-text drop-shadow-[0_8px_24px_var(--nova-accent-glow)]" aria-hidden />
      </div>
      {!compact && (
        <div className="mt-4 flex gap-5 text-[12px] text-fg-muted tabular-nums">
          <span className="flex items-center gap-1.5">
            <Droplets size={13} aria-hidden /> {Math.round(data.current.humidity)}%
          </span>
          <span className="flex items-center gap-1.5">
            <Wind size={13} aria-hidden /> {Math.round(data.current.windSpeed)} {data.windUnit}
          </span>
          <span className="flex items-center gap-1.5">
            <Sunrise size={13} aria-hidden /> {time(today?.sunrise ?? null)}
          </span>
          <span className="flex items-center gap-1.5">
            <Sunset size={13} aria-hidden /> {time(today?.sunset ?? null)}
          </span>
        </div>
      )}
      <ul className={compact ? "mt-auto grid grid-cols-3 gap-2 pt-3" : "mt-5 grid grid-cols-6 gap-2"}>
        {days.map((day, i) => {
          const d = describeWeather(day.weatherCode);
          const DayIcon = d.icon;
          const label = !compact && i === 0 ? "Today" : new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(`${day.date}T12:00`));
          return (
            <li key={day.date} className="flex flex-col items-center gap-1 rounded-[12px] bg-white/[0.035] py-2 text-[12px]" title={d.label}>
              <span className="text-fg-subtle">{label}</span>
              <DayIcon size={18} className="text-fg-muted" aria-label={d.label} />
              <span className="text-fg tabular-nums">
                {Math.round(day.max)}° <span className="text-fg-subtle">{Math.round(day.min)}°</span>
              </span>
              {!compact && day.precipitationProbability !== null && <span className="text-[11px] text-fg-subtle tabular-nums">{day.precipitationProbability}%</span>}
            </li>
          );
        })}
      </ul>
      {!compact && <p className="mt-3 text-[11px] text-fg-subtle">Updated {new Date(data.fetchedAtMs).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })} · {unit}</p>}
    </div>
  );
}

export function NewsList({ limit = 40, compact = false }: { limit?: number; compact?: boolean }) {
  const feeds = useSettings((s) => s.newsFeeds);
  const results = useFeeds(feeds);
  if (feeds.length === 0) {
    return <p className="flex h-full items-center justify-center text-center text-[13px] text-fg-muted">Add RSS or Atom feeds in Live Information to see headlines.</p>;
  }
  const items = mergeFeeds(feeds, results.map((r) => r.data), limit);
  const failed = results.filter((r) => r.error).length;
  const loading = results.some((r) => r.isPending);
  return (
    <div className="flex h-full flex-col">
      {loading && items.length === 0 && <Skeleton className="h-20" />}
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {items.map((item, i) => (
          <li key={`${item.link ?? item.title}-${i}`}>
            <button
              type="button"
              disabled={!item.link}
              onClick={() => item.link && openLink(item.link)}
              title={item.link ?? undefined}
              className="w-full rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05] disabled:cursor-default"
            >
              <span className={compact ? "line-clamp-1 text-[13px] text-fg" : "line-clamp-2 text-[13.5px] leading-snug text-fg"}>{item.title}</span>
              <span className="mt-0.5 block text-[11px] text-fg-subtle">
                {item.source}
                {item.at ? ` · ${new Date(item.at).toLocaleString(uiLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {failed > 0 && <p className="mt-2 text-[11px] text-warning">{failed} feed{failed > 1 ? "s" : ""} couldn't be loaded.</p>}
    </div>
  );
}

export function FeedManager() {
  const feeds = useSettings((s) => s.newsFeeds);
  const addFeed = useSettings((s) => s.addNewsFeed);
  const removeFeed = useSettings((s) => s.removeNewsFeed);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      // Validate by fetching once, so broken addresses are caught right away.
      const feed = await fetchFeed(url.trim());
      addFeed({ url: url.trim(), title: feed.title || new URL(url.trim()).hostname });
      notify(`Added ${feed.title || "feed"}`, { kind: "success", body: `${feed.items.length} articles` });
      setUrl("");
    } catch (error) {
      notifyError("Couldn't add this feed", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ul className="mb-3 space-y-1">
        {feeds.map((feed) => (
          <li key={feed.url} className="group flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-white/[0.04]">
            <Newspaper size={14} className="shrink-0 text-accent-text" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-fg">{feed.title}</span>
              <span className="block truncate text-[11px] text-fg-subtle">{feed.url}</span>
            </span>
            <IconButton size="sm" label={`Remove ${feed.title}`} onClick={() => removeFeed(feed.url)} className="opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100">
              <Trash size={13} />
            </IconButton>
          </li>
        ))}
      </ul>
      {feeds.length < MAX_NEWS_FEEDS && (
        <form onSubmit={add} className="flex gap-2">
          <label className="flex h-10 flex-1 items-center rounded-control border border-line bg-black/25 px-3 focus-within:border-line-strong">
            <span className="sr-only">Feed address</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" className="h-full flex-1 bg-transparent text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle" />
          </label>
          <Button type="submit" size="md" variant="secondary" icon={<Plus size={14} />} disabled={busy || !/^https?:\/\/\S+\.\S+/i.test(url.trim())}>
            {busy ? "Checking…" : "Add feed"}
          </Button>
        </form>
      )}
    </div>
  );
}
