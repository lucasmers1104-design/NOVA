import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { CommandPalette } from "./CommandPalette";

function openPalette() {
  act(() => useUi.getState().setPaletteOpen(true));
}

describe("CommandPalette", () => {
  beforeEach(() => {
    useSettings.setState(defaultSettings());
    useUi.setState({ route: "home", paletteOpen: false });
  });

  it("is closed until opened", () => {
    render(<CommandPalette />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    openPalette();
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("filters and runs the top result with Enter", async () => {
    render(<CommandPalette />);
    openPalette();

    await userEvent.type(screen.getByRole("combobox"), "settings");
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Go to Settings");
    await userEvent.keyboard("{Enter}");

    expect(useUi.getState().route).toBe("settings");
    expect(useUi.getState().paletteOpen).toBe(false);
  });

  it("moves the selection with arrow keys", async () => {
    render(<CommandPalette />);
    openPalette();

    await userEvent.type(screen.getByRole("combobox"), "accent");
    const [first, second] = screen.getAllByRole("option");
    expect(first).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{ArrowDown}");
    expect(second).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{Enter}");
    expect(useSettings.getState().accent).toEqual({ kind: "preset", id: "blue" });
  });

  it("jumps to the last and first result with Ctrl+End / Ctrl+Home", async () => {
    render(<CommandPalette />);
    openPalette();

    const options = screen.getAllByRole("option");
    await userEvent.keyboard("{Control>}{End}{/Control}");
    expect(options[options.length - 1]).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{Control>}{Home}{/Control}");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("shows an empty state and closes with Escape", async () => {
    render(<CommandPalette />);
    openPalette();

    await userEvent.type(screen.getByRole("combobox"), "zzzz");
    expect(screen.getByText(/No commands match/)).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(useUi.getState().paletteOpen).toBe(false);
  });

  it("toggles the sidebar through a registered command", async () => {
    render(<CommandPalette />);
    openPalette();

    await userEvent.type(screen.getByRole("combobox"), "collapse");
    await userEvent.keyboard("{Enter}");
    expect(useSettings.getState().sidebarCollapsed).toBe(true);
  });
});
