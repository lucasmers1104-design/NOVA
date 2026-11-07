import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callNative } from "@/lib/native";
import { usePluginWidgets } from "@/widgets/pluginRegistry";
import { allWidgets, getWidget } from "@/widgets/registry";
import type { PluginInfo } from "./api";
import { PluginFrame } from "./PluginFrame";
import { pluginWidgetDefinitions } from "./usePluginSync";

vi.mock("@/lib/native", async (original) => ({ ...(await original<typeof import("@/lib/native")>()), isDesktop: () => true, callNative: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

const native = vi.mocked(callNative);

const plugin = (overrides: Partial<PluginInfo> = {}): PluginInfo => ({
  id: "dev.example.hello",
  name: "Hello",
  version: "1.0.0",
  description: "A test",
  author: "",
  channel: "public",
  signed: true,
  enabled: true,
  problem: null,
  lastError: null,
  entryUrl: "http://novaplugin.localhost/dev.example.hello/1.0.0/index.html",
  permissions: [],
  pages: [],
  widgets: [{ key: "p_abc_w", id: "w", name: "Widget", description: "", w: 4, h: 2 }],
  themes: [],
  ...overrides,
});

describe("plugin widgets", () => {
  beforeEach(() => usePluginWidgets.setState({ widgets: [] }));

  it("join the registry only while the plugin can run", () => {
    expect(pluginWidgetDefinitions([plugin()]).map((w) => w.id)).toEqual(["p_abc_w"]);
    expect(pluginWidgetDefinitions([plugin({ enabled: false })])).toEqual([]);
    expect(pluginWidgetDefinitions([plugin({ problem: "Needs NOVA 9" })])).toEqual([]);
  });

  it("are found next to the built-in ones", () => {
    const before = allWidgets().length;
    usePluginWidgets.setState({ widgets: pluginWidgetDefinitions([plugin()]) });
    expect(allWidgets().length).toBe(before + 1);
    expect(getWidget("p_abc_w")?.category).toBe("plugin");
    expect(getWidget("cpu")).toBeTruthy();
  });

  it("say so when they use the network", () => {
    const [definition] = pluginWidgetDefinitions([plugin({ permissions: [{ key: "network", label: "x", granted: true }] })]);
    expect(definition?.dataSource).toBe("network");
  });
});

describe("the plugin frame", () => {
  beforeEach(() => native.mockReset());

  function mount() {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PluginFrame plugin={plugin()} view="widget:w" title="Widget" />
      </QueryClientProvider>,
    );
    return screen.getByTitle("Widget") as HTMLIFrameElement;
  }

  it("has scripts and nothing else: no origin, no popups, no top navigation", () => {
    const frame = mount();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toContain("?view=widget%3Aw");
  });

  it("forwards a call from its own frame with the plugin id it knows", async () => {
    native.mockResolvedValue("value");
    const frame = mount();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { nova: 1, id: 7, method: "storage.get", params: { key: "k" }, pluginId: "someone.else" } }));
    });
    await waitFor(() => expect(native).toHaveBeenCalledWith("plugin_call", { pluginId: "dev.example.hello", method: "storage.get", params: { key: "k" } }));
  });

  it("ignores messages from anywhere else", () => {
    mount();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: window, data: { nova: 1, id: 1, method: "storage.get", params: {} } }));
      window.dispatchEvent(new MessageEvent("message", { data: { nova: 1, id: 2, method: "storage.get", params: {} } }));
    });
    expect(native).not.toHaveBeenCalled();
  });
});
