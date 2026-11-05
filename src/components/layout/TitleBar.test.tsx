import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { renderWithQuery } from "@/test/render";
import { TitleBar } from "./TitleBar";

describe("TitleBar clock", () => {
  beforeEach(() => {
    useSettings.setState({ ...defaultSettings(), use24HourClock: true });
    useUi.setState({ route: "home", paletteOpen: false });
  });

  it("stays hidden by default", () => {
    renderWithQuery(<TitleBar />);
    expect(screen.queryByText(/\d{2}:\d{2}/)).not.toBeInTheDocument();
  });

  it("shows the time, optionally with the date", () => {
    useSettings.setState({ titleBarClock: "time" });
    const { unmount } = renderWithQuery(<TitleBar />);
    expect(screen.getByText(/^\d{2}:\d{2}$/)).toBeInTheDocument();
    unmount();

    useSettings.setState({ titleBarClock: "time-date" });
    renderWithQuery(<TitleBar />);
    expect(screen.getByText(/ · \d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it("follows the 12-hour setting", () => {
    useSettings.setState({ titleBarClock: "time", use24HourClock: false });
    renderWithQuery(<TitleBar />);
    expect(screen.getByText(/^\d{1,2}:\d{2} (AM|PM)$/)).toBeInTheDocument();
  });
});
