import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChoiceCards, ColorPicker, DragChips, PreviewStage, ResetButton, SettingCard, SettingLine, ShortcutRecorder, shortcutFromEvent, SliderRow, SortableList } from ".";

describe("SliderRow", () => {
  it("says its value and goes back to the standard on a double-click", () => {
    const onChange = vi.fn();
    render(<SliderRow label="Eckenradius" value={30} min={8} max={40} defaultValue={22} format={(v) => `${v} px`} onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Eckenradius" });
    expect(screen.getByText("30 px")).toBeTruthy();
    expect(slider.getAttribute("aria-valuetext")).toBe("30 px");
    fireEvent.change(slider, { target: { value: "12" } });
    expect(onChange).toHaveBeenLastCalledWith(12);
    fireEvent.doubleClick(slider);
    expect(onChange).toHaveBeenLastCalledWith(22);
  });

  it("offers the way back only while the value differs, also without a mouse", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SliderRow label="Tempo" value={100} min={50} max={200} defaultValue={100} onChange={onChange} />);
    expect(screen.queryByRole("button", { name: "Tempo auf Standard zurücksetzen" })).toBeNull();
    rerender(<SliderRow label="Tempo" value={150} min={50} max={200} defaultValue={100} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Tempo auf Standard zurücksetzen" }));
    expect(onChange).toHaveBeenCalledWith(100);
  });
});

describe("ChoiceCards", () => {
  const options = [
    { value: "black", label: "Schwarz" },
    { value: "white", label: "Weiß" },
    { value: "glass", label: "Glas" },
  ] as const;

  it("chooses by click and by arrow key, wrapping around", () => {
    const onChange = vi.fn();
    render(<ChoiceCards label="Design" value="black" options={options} onChange={onChange} />);
    const cards = screen.getAllByRole("radio");
    expect(cards.map((card) => card.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    // One tab stop for the whole group.
    expect(cards.map((card) => card.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.click(screen.getByRole("radio", { name: /Glas/ }));
    expect(onChange).toHaveBeenLastCalledWith("glass");
    fireEvent.keyDown(cards[0]!, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("glass");
    fireEvent.keyDown(cards[0]!, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("white");
  });
});

describe("ColorPicker", () => {
  it("takes swatches, the automatic choice and only valid hex colors", () => {
    const onChange = vi.fn();
    render(<ColorPicker label="Akzent" value={null} swatches={["#8b5cf6", "#22d3ee"]} autoLabel="Wie NOVA" onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "Wie NOVA" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "#22d3ee" }));
    expect(onChange).toHaveBeenLastCalledWith("#22d3ee");
    onChange.mockClear();
    const hex = screen.getByLabelText("Hex");
    fireEvent.change(hex, { target: { value: "#12" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(hex.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(hex, { target: { value: "#FFAA00" } });
    expect(onChange).toHaveBeenLastCalledWith("#ffaa00");
  });

  it("calls a swatch by its name when it has one", () => {
    const onChange = vi.fn();
    render(<ColorPicker label="Akzent" value="#22d3ee" swatches={["#8b5cf6", "#22d3ee"]} swatchName={(swatch) => (swatch === "#22d3ee" ? "Cyan" : "Violett")} onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "Cyan" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Violett" }));
    expect(onChange).toHaveBeenLastCalledWith("#8b5cf6");
  });
});

describe("SortableList", () => {
  function Modules({ onOrder }: { onOrder: (ids: string[]) => void }) {
    const [items, setItems] = useState([{ id: "calls" }, { id: "ai" }, { id: "music" }]);
    return (
      <SortableList
        label="Reihenfolge"
        items={items}
        itemLabel={(item) => item.id}
        onReorder={(next) => {
          setItems(next);
          onOrder(next.map((item) => item.id));
        }}
        renderItem={(item) => <span>{item.id}</span>}
      />
    );
  }

  it("moves a card with the keyboard: Space, arrows, Space", () => {
    const onOrder = vi.fn();
    render(<Modules onOrder={onOrder} />);
    const handle = screen.getByRole("button", { name: "music verschieben" });
    // Arrows do nothing before the card is picked up.
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(onOrder).not.toHaveBeenCalled();
    fireEvent.keyDown(handle, { key: " " });
    expect(handle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(onOrder).toHaveBeenLastCalledWith(["calls", "music", "ai"]);
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(onOrder).toHaveBeenLastCalledWith(["music", "calls", "ai"]);
    expect(screen.getByRole("status").textContent).toBe("music: Platz 1 von 3");
    fireEvent.keyDown(handle, { key: " " });
    expect(handle.getAttribute("aria-pressed")).toBe("false");
  });

  it("puts a card back where it was on Escape", () => {
    const onOrder = vi.fn();
    render(<Modules onOrder={onOrder} />);
    const handle = screen.getByRole("button", { name: "calls verschieben" });
    fireEvent.keyDown(handle, { key: "Enter" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(onOrder).toHaveBeenLastCalledWith(["ai", "music", "calls"]);
    fireEvent.keyDown(handle, { key: "Escape" });
    expect(onOrder).toHaveBeenLastCalledWith(["calls", "ai", "music"]);
  });
});

describe("DragChips", () => {
  it("puts a chip into the chosen zone without dragging", () => {
    const onAssign = vi.fn();
    render(
      <DragChips
        label="Inhalte"
        chips={[
          { value: "cover", label: "Cover" },
          { value: "clock", label: "Uhrzeit" },
          { value: "none", label: "Nichts" },
        ]}
        zones={[
          { id: "left", label: "Links" },
          { id: "right", label: "Rechts" },
        ]}
        assigned={{ left: "cover", right: "none" }}
        onAssign={onAssign}
      />,
    );
    // The first zone is the target until another one is chosen.
    expect(screen.getByRole("button", { name: "Cover nach Links" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Uhrzeit nach Links" }));
    expect(onAssign).toHaveBeenLastCalledWith("left", "clock");
    fireEvent.click(screen.getByRole("radio", { name: /Rechts/ }));
    fireEvent.click(screen.getByRole("button", { name: "Uhrzeit nach Rechts" }));
    expect(onAssign).toHaveBeenLastCalledWith("right", "clock");
    expect(screen.getByRole("status").textContent).toBe("Uhrzeit: Rechts");
  });
});

describe("ShortcutRecorder", () => {
  it("names the pressed keys", () => {
    expect(shortcutFromEvent({ key: "n", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBe("Ctrl+Alt+N");
    expect(shortcutFromEvent({ key: " ", ctrlKey: false, altKey: false, shiftKey: true, metaKey: true })).toBe("Shift+Win+Space");
    expect(shortcutFromEvent({ key: "Control", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBeNull();
  });

  it("names the key, not the character a modifier turns it into", () => {
    // German keyboard: Ctrl+Alt is AltGr, so Q types "@" and E types "€".
    expect(shortcutFromEvent({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBe("Ctrl+Alt+Q");
    expect(shortcutFromEvent({ key: "!", code: "Digit1", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false })).toBe("Ctrl+Shift+1");
    // A letter stays the letter it types: Z and Y swap places between keyboards.
    expect(shortcutFromEvent({ key: "z", code: "KeyY", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe("Ctrl+Z");
  });

  it("records a shortcut, wants a modifier, and lets Escape cancel", () => {
    const onChange = vi.fn();
    render(<ShortcutRecorder label="NOVA öffnen" value="Ctrl+Alt+N" onChange={onChange} clearable />);
    const button = screen.getByRole("button", { name: /NOVA öffnen: Ctrl\+Alt\+N/ });
    // Not recording yet: keys pass through.
    fireEvent.keyDown(button, { key: "k", ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "k" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/Strg/);
    fireEvent.keyDown(button, { key: "Escape" });
    fireEvent.keyDown(button, { key: "k", ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "k", ctrlKey: true, shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith("Ctrl+Shift+K");
    fireEvent.click(screen.getByRole("button", { name: "NOVA öffnen entfernen" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("takes an F-key alone", () => {
    const onChange = vi.fn();
    render(<ShortcutRecorder label="Clip" value={null} onChange={onChange} />);
    const button = screen.getByRole("button", { name: /Clip: nicht belegt/ });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "F9" });
    expect(onChange).toHaveBeenLastCalledWith("F9");
  });
});

describe("ResetButton", () => {
  it("resets on the second click only", () => {
    const onReset = vi.fn();
    render(<ResetButton label="Auf Standard zurücksetzen" onReset={onReset} />);
    fireEvent.click(screen.getByRole("button", { name: "Auf Standard zurücksetzen" }));
    expect(onReset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Wirklich zurücksetzen" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Auf Standard zurücksetzen" })).toBeTruthy();
  });

  it("calms down by itself", () => {
    vi.useFakeTimers();
    try {
      const onReset = vi.fn();
      render(<ResetButton onReset={onReset} />);
      fireEvent.click(screen.getByRole("button", { name: "Zurücksetzen …" }));
      act(() => {
        vi.advanceTimersByTime(4100);
      });
      fireEvent.click(screen.getByRole("button"));
      expect(onReset).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SettingCard and PreviewStage", () => {
  it("names the card and marks each setting for the search", () => {
    render(
      <SettingCard title="Form" description="Größe und Ecken">
        <SettingLine label="Im Vollbild ausblenden">
          <button type="button">x</button>
        </SettingLine>
      </SettingCard>,
    );
    expect(screen.getByRole("region", { name: "Form" })).toBeTruthy();
    expect(document.querySelector('[data-setting="Im Vollbild ausblenden"]')).toBeTruthy();
  });

  it("frames what it previews", () => {
    render(
      <PreviewStage label="Vorschau der Island" backdrop="dusk" taskbar>
        <span>Island</span>
      </PreviewStage>,
    );
    expect(screen.getByRole("group", { name: "Vorschau der Island" }).textContent).toBe("Island");
  });
});
