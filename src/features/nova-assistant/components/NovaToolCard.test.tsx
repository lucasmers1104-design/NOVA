import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InlineCodeRenderer, Markdown } from "@/components/ui/Markdown";
import { openNova, openPath, openWebPage } from "../api";
import type { ToolItem } from "../conversation";
import type { ToolCard } from "../types";
import { NovaToolCard, renderPathCode } from "./NovaToolCard";

vi.mock("../api", () => ({ openPath: vi.fn(() => Promise.resolve()), openNova: vi.fn(() => Promise.resolve()), openWebPage: vi.fn(() => Promise.resolve()) }));

const done = (card: ToolCard) => ({ id: "t", name: "x", title: "Did it", risk: "safe", state: "done", summary: "ok", detail: null, card }) as unknown as ToolItem;
const PATH = "C:\\Users\\Luca\\Documents\\Bericht final.pdf";

describe("what NOVA AI's cards offer", () => {
  const writeText = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("opens, shows and copies any path", async () => {
    render(<NovaToolCard tool={done({ kind: "path", path: PATH })} onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Bericht final.pdf" }));
    expect(openPath).toHaveBeenCalledWith(PATH);
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(openPath).toHaveBeenCalledWith(PATH, true);
    fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith(PATH);
    await waitFor(() => screen.getByRole("button", { name: "Path copied" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy name" }));
    expect(writeText).toHaveBeenCalledWith("Bericht final.pdf");
  });

  it("links to the Productivity page and to web pages", () => {
    render(<NovaToolCard tool={done({ kind: "productivity", label: "Müll rausbringen", detail: "Due 2026-11-06" })} onConfirm={() => {}} />);
    expect(screen.getByText("Müll rausbringen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(openNova).toHaveBeenCalledWith("productivity");
    render(<NovaToolCard tool={done({ kind: "link", url: "https://www.kfc.de/menu", title: "KFC" })} onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "www.kfc.de" }));
    expect(openWebPage).toHaveBeenCalledWith("https://www.kfc.de/menu");
  });

  it("makes paths in a reply clickable and leaves other code alone", () => {
    expect(renderPathCode("npm run dev")).toBeNull();
    expect(renderPathCode("C:temp")).toBeNull();
    const { container } = render(
      <InlineCodeRenderer.Provider value={renderPathCode}>
        <Markdown source={`Liegt hier: \`${PATH}\` und \`npm run dev\``} />
      </InlineCodeRenderer.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: PATH }));
    expect(openPath).toHaveBeenCalledWith(PATH);
    expect(container.querySelector("code")?.textContent).toBe("npm run dev");
  });

  it("keeps inline code plain everywhere else", () => {
    const { container } = render(<Markdown source={`\`${PATH}\``} />);
    expect(container.querySelector("code")?.textContent).toBe(PATH);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
