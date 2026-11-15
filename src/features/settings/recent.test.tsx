import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { ago, MAX_RECENT, sanitizeRecent, useRecentSettings, useRecordChanges } from "./recent";

const labels = () => useRecentSettings.getState().recent.map((entry) => `${entry.section}/${entry.label}`);

describe("the settings changed last", () => {
  beforeEach(() => useRecentSettings.setState({ recent: [] }));

  it("keeps the newest first, each setting once, and only a handful", () => {
    const { record } = useRecentSettings.getState();
    record("appearance", "Ecken", 1);
    record("wake", "Auch in Spielen", 2);
    record("appearance", "Ecken", 3);
    expect(useRecentSettings.getState().recent).toEqual([
      { section: "appearance", label: "Ecken", at: 3 },
      { section: "wake", label: "Auch in Spielen", at: 2 },
    ]);
    // The same name in another section is another setting.
    record("island", "Ecken", 4);
    expect(labels()).toEqual(["island/Ecken", "appearance/Ecken", "wake/Auch in Spielen"]);
    for (let i = 0; i < 10; i++) record("system", `Einstellung ${i}`, 10 + i);
    expect(useRecentSettings.getState().recent).toHaveLength(MAX_RECENT);
    expect(labels()[0]).toBe("system/Einstellung 9");
  });

  it("drops what a damaged store hands back", () => {
    expect(sanitizeRecent("garbage")).toEqual([]);
    expect(sanitizeRecent([{ section: "wake", label: "Ton beim Wecken", at: 5 }, { section: 1, label: "x", at: 5 }, null, { section: "wake", label: "y", at: Number.NaN }])).toEqual([{ section: "wake", label: "Ton beim Wecken", at: 5 }]);
  });

  it("says how long ago that was", () => {
    const now = Date.UTC(2026, 10, 11, 12);
    expect(ago(now - 20_000, now)).toBe("gerade eben");
    expect(ago(now - 5 * 60_000, now)).toBe("vor 5 Minuten");
    expect(ago(now - 3 * 3_600_000, now)).toBe("vor 3 Stunden");
    expect(ago(now - 26 * 3_600_000, now)).toBe("gestern");
  });
});

/** A page of settings as the kit builds them: every row carries its name in `data-setting`. */
function Page() {
  const page = useRef<HTMLDivElement>(null);
  useRecordChanges(page, "dashboard");
  return (
    <div ref={page}>
      <div data-setting="24-Stunden-Uhr">
        <button type="button" role="switch" aria-checked="false" aria-label="24-Stunden-Uhr" />
        <button type="button">Mehr erfahren</button>
      </div>
      <div data-setting="Glasstärke">
        <input type="range" aria-label="Glasstärke" defaultValue={50} />
      </div>
      <div data-setting="Uhr in der Titelleiste" role="radiogroup">
        <button type="button" role="radio" aria-checked="true">
          Aus
        </button>
        <button type="button" role="radio" aria-checked="false">
          Uhrzeit
        </button>
      </div>
      <div data-setting="Akzentfarbe" data-no-record>
        <button type="button" role="radio" aria-checked="false">
          Cyan
        </button>
        <button type="button" data-records>
          Akzent übernehmen
        </button>
      </div>
      <div data-setting="Discord-Kanal">
        <form onSubmit={(event) => event.preventDefault()}>
          <input aria-label="Webhook" />
          <button type="submit">Speichern</button>
        </form>
      </div>
      <div data-setting="Auch in Spielen" data-setting-section="wake">
        <button type="button" role="switch" aria-checked="true" aria-label="Auch in Spielen" />
      </div>
      <div data-setting="Reihenfolge">
        <button type="button" aria-pressed="true" aria-label="Apps verschieben" />
      </div>
      <button type="button" role="switch" aria-checked="false" aria-label="Ohne Zeile" />
    </div>
  );
}

describe("recording changes in one place", () => {
  beforeEach(() => useRecentSettings.setState({ recent: [] }));

  it("notes a flipped switch, a moved slider and a new choice by the name of their row", () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("switch", { name: "24-Stunden-Uhr" }));
    expect(labels()).toEqual(["dashboard/24-Stunden-Uhr"]);
    fireEvent.change(screen.getByRole("slider", { name: "Glasstärke" }), { target: { value: "70" } });
    expect(labels()[0]).toBe("dashboard/Glasstärke");
    fireEvent.click(screen.getByRole("radio", { name: "Uhrzeit" }));
    expect(labels()[0]).toBe("dashboard/Uhr in der Titelleiste");
  });

  it("leaves out what changes nothing", () => {
    render(<Page />);
    // A plain button in a row, the choice that is already made, and a control outside any row.
    fireEvent.click(screen.getByRole("button", { name: "Mehr erfahren" }));
    fireEvent.click(screen.getByRole("radio", { name: "Aus" }));
    fireEvent.click(screen.getByRole("switch", { name: "Ohne Zeile" }));
    expect(labels()).toEqual([]);
  });

  it("counts a draft only once it is applied, and a form only once it is sent", () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("radio", { name: "Cyan" }));
    expect(labels()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Akzent übernehmen" }));
    expect(labels()).toEqual(["dashboard/Akzentfarbe"]);

    fireEvent.change(screen.getByLabelText("Webhook"), { target: { value: "https://discord.com/api/webhooks/1/abc" } });
    expect(labels()).toEqual(["dashboard/Akzentfarbe"]);
    fireEvent.submit(screen.getByLabelText("Webhook").closest("form")!);
    expect(labels()[0]).toBe("dashboard/Discord-Kanal");
  });

  it("files a setting shown outside its section under the section it belongs to", () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("switch", { name: "Auch in Spielen" }));
    expect(labels()).toEqual(["wake/Auch in Spielen"]);
  });

  it("notes a card moved with the keyboard or dragged, but not a mere press", () => {
    render(<Page />);
    const grip = screen.getByRole("button", { name: "Apps verschieben" });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(labels()).toEqual(["dashboard/Reihenfolge"]);

    useRecentSettings.setState({ recent: [] });
    fireEvent.pointerDown(grip, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 11, clientY: 12 });
    expect(labels()).toEqual([]);
    fireEvent.pointerDown(grip, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 60 });
    expect(labels()).toEqual(["dashboard/Reihenfolge"]);
  });
});
