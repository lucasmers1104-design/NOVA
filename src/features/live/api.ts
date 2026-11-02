import { useQueries, useQuery } from "@tanstack/react-query";
import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, type LucideIcon, Moon, Sun } from "lucide-react";
import { callNative } from "@/lib/native";
import { type NewsFeed, useSettings, type WeatherPlace } from "@/stores/settings";

export interface Forecast {
  current: { temperature: number; apparentTemperature: number; humidity: number; windSpeed: number; weatherCode: number; isDay: boolean };
  daily: { date: string; weatherCode: number; max: number; min: number; precipitationProbability: number | null; sunrise: string | null; sunset: string | null }[];
  temperatureUnit: string;
  windUnit: string;
  fetchedAtMs: number;
}

export interface FeedItem {
  title: string;
  link: string | null;
  published: string | null;
}

export interface Feed {
  title: string;
  items: FeedItem[];
}

export function searchPlaces(query: string): Promise<WeatherPlace[]> {
  return callNative<WeatherPlace[]>("weather_search", { query });
}

/** Weather refreshes every 20 minutes, and only after the user chose a place. */
export function useForecast() {
  const place = useSettings((s) => s.weatherPlace);
  const fahrenheit = useSettings((s) => s.weatherFahrenheit);
  return useQuery({
    queryKey: ["weather", place?.latitude, place?.longitude, fahrenheit],
    queryFn: () => callNative<Forecast>("weather_forecast", { latitude: place!.latitude, longitude: place!.longitude, fahrenheit }),
    enabled: place !== null,
    staleTime: 15 * 60_000,
    refetchInterval: 20 * 60_000,
    refetchIntervalInBackground: false,
  });
}

export function fetchFeed(url: string): Promise<Feed> {
  return callNative<Feed>("news_fetch", { url });
}

/** All configured feeds, refreshed every 30 minutes. */
export function useFeeds(feeds: readonly NewsFeed[]) {
  return useQueries({
    queries: feeds.map((feed) => ({
      queryKey: ["news", feed.url],
      queryFn: () => fetchFeed(feed.url),
      staleTime: 15 * 60_000,
      refetchInterval: 30 * 60_000,
      refetchIntervalInBackground: false,
    })),
  });
}

export function parseFeedDate(value: string | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

export interface MergedItem extends FeedItem {
  source: string;
  at: number;
}

export function mergeFeeds(feeds: readonly NewsFeed[], results: readonly (Feed | undefined)[], limit = 40): MergedItem[] {
  const items: MergedItem[] = [];
  results.forEach((feed, i) => {
    if (!feed) return;
    for (const item of feed.items) items.push({ ...item, source: feeds[i]?.title || feed.title, at: parseFeedDate(item.published) });
  });
  return items.sort((a, b) => b.at - a.at).slice(0, limit);
}

export function openLink(url: string) {
  void callNative("open_url", { url });
}

/** WMO weather interpretation codes, as used by Open-Meteo. */
export function describeWeather(code: number, isDay = true): { label: string; icon: LucideIcon } {
  if (code === 0) return { label: "Clear", icon: isDay ? Sun : Moon };
  if (code === 1) return { label: "Mainly clear", icon: isDay ? Sun : Moon };
  if (code === 2) return { label: "Partly cloudy", icon: isDay ? CloudSun : CloudMoon };
  if (code === 3) return { label: "Overcast", icon: Cloud };
  if (code === 45 || code === 48) return { label: "Fog", icon: CloudFog };
  if (code >= 51 && code <= 57) return { label: "Drizzle", icon: CloudDrizzle };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: code >= 80 ? "Rain showers" : "Rain", icon: CloudRain };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: "Snow", icon: CloudSnow };
  if (code >= 95) return { label: code === 95 ? "Thunderstorm" : "Thunderstorm with hail", icon: CloudLightning };
  return { label: "Unknown", icon: Cloud };
}

export function placeLabel(place: WeatherPlace): string {
  return [place.name, place.region && place.region !== place.name ? place.region : null, place.country].filter(Boolean).join(", ");
}
