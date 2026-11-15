import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { iconSrc, knownApp } from "./app-icons";
import type { IslandActions, IslandData } from "./data";
import { IslandView } from "./IslandView";
import { AppLogo } from "./modules";
import { sceneById } from "./scenes";
import { DEFAULT_ISLAND_PREFS, type IslandPrefs } from "./types";

// 1×1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG_URL = `data:image/png;base64,${PNG_BASE64}`;

describe("iconSrc", () => {
  it("passes PNG and WebP data URLs", () => {
    expect(iconSrc(PNG_URL)).toBe(PNG_URL);
    expect(iconSrc("data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==")).toMatch(/^data:image\/webp;base64,/);
  });

  it("names bare base64 by its first bytes (older PCs passed the phone's icon as is)", () => {
    expect(iconSrc(PNG_BASE64)).toBe(PNG_URL);
    expect(iconSrc("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==")).toMatch(/^data:image\/webp;base64,UklGR/);
  });

  it("refuses everything else", () => {
    expect(iconSrc(null)).toBeNull();
    expect(iconSrc(undefined)).toBeNull();
    expect(iconSrc("")).toBeNull();
    expect(iconSrc("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull();
    expect(iconSrc("data:text/html;base64,PGgxPmhpPC9oMT4=")).toBeNull();
    expect(iconSrc(`${PNG_URL}"><script>`)).toBeNull();
    expect(iconSrc("https://example.com/logo.png")).toBeNull();
    expect(iconSrc("/9j/4AAQSkZJRgABAQ==")).toBeNull(); // JPEG
    expect(iconSrc(`data:image/png;base64,${"A".repeat(300_000)}`)).toBeNull();
  });
});

describe("knownApp", () => {
  it("knows apps by Android package, Windows id, exe or name", () => {
    expect(knownApp("com.zhiliaoapp.musically")?.name).toBe("TikTok");
    expect(knownApp("com.ss.android.ugc.trill")?.name).toBe("TikTok");
    expect(knownApp("Spotify.exe")?.name).toBe("Spotify");
    expect(knownApp("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify")?.name).toBe("Spotify");
    expect(knownApp("com.whatsapp")?.name).toBe("WhatsApp");
    expect(knownApp("com.discord")?.name).toBe("Discord");
    expect(knownApp("com.instagram.android")?.name).toBe("Instagram");
    expect(knownApp("com.google.android.youtube")?.name).toBe("YouTube");
    expect(knownApp("com.facebook.orca")?.name).toBe("Messenger");
    expect(knownApp("com.google.android.gm")?.name).toBe("Gmail");
    expect(knownApp("unknown.package", "Discord")?.name).toBe("Discord");
  });

  it("leaves unknown apps alone", () => {
    expect(knownApp("com.example.notes", "Notizen")).toBeNull();
    expect(knownApp("com.valvesoftware.android.steam.community")).toBeNull();
    expect(knownApp(null, undefined, "")).toBeNull();
  });
});

describe("AppLogo", () => {
  it("shows the real logo as an image", () => {
    const { container } = render(<AppLogo icon={PNG_URL} id="com.zhiliaoapp.musically" name="TikTok" size={24} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(PNG_URL);
  });

  it("never puts anything but a PNG/WebP data URL into the image", () => {
    const { container } = render(<AppLogo icon="javascript:alert(1)" id="com.example.notes" name="Notizen" size={24} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("N");
  });

  it("falls back to a colored glyph for well-known apps, the letter for others", () => {
    const known = render(<AppLogo icon={null} id="com.zhiliaoapp.musically" name="TikTok" size={24} />);
    expect(known.container.querySelector("[data-app='TikTok'] svg")).not.toBeNull();
    const other = render(<AppLogo icon={null} id="com.example.notes" name="notizen" size={24} />);
    expect(other.container.textContent).toBe("N");
  });

  it("falls back when the picture doesn't load", () => {
    const { container } = render(<AppLogo icon={PNG_URL} id="Spotify.exe" name="Spotify" size={24} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-app='Spotify']")).not.toBeNull();
  });
});

describe("the app-icon slot", () => {
  const actions: IslandActions = { mediaControl: vi.fn(), lyrics: vi.fn(async () => []), callAction: vi.fn(), talk: vi.fn(), openAssistant: vi.fn(), menu: vi.fn() };
  const prefs: IslandPrefs = {
    ...DEFAULT_ISLAND_PREFS,
    slots: { ...DEFAULT_ISLAND_PREFS.slots, music: { left: "appIcon", right: "none" }, notification: { left: "appIcon", right: "none" } },
  };
  const view = (data: IslandData) => render(<IslandView prefs={prefs} data={data} actions={actions} expanded={false} lyrics={false} hovered={false} onExpanded={vi.fn()} onLyrics={vi.fn()} />);
  const slotImage = () => document.querySelector<HTMLImageElement>("[data-item='appIcon'] img");

  it("shows the PC player's logo instead of its first letter", () => {
    const music = sceneById("music").data(Date.now());
    view({ ...music, media: { ...music.media, appIcon: PNG_URL } });
    expect(slotImage()?.getAttribute("src")).toBe(PNG_URL);
  });

  it("shows the phone app's logo", () => {
    const notification = sceneById("notification").data(Date.now());
    view({ ...notification, notice: { ...notification.notice!, app: "com.zhiliaoapp.musically", appName: "TikTok", icon: PNG_URL } });
    expect(slotImage()?.getAttribute("src")).toBe(PNG_URL);
  });

  it("without a logo, Spotify still gets its glyph rather than an S", () => {
    view(sceneById("music").data(Date.now()));
    expect(slotImage()).toBeNull();
    expect(document.querySelector("[data-item='appIcon'] [data-app='Spotify']")).not.toBeNull();
  });
});
