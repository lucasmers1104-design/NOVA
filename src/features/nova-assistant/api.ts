import { Channel } from "@tauri-apps/api/core";
import { callNative } from "@/lib/native";
import type {
  ActionEntry,
  AgentEvent,
  AgentPrefs,
  AgentStatus,
  AssistantPrefsUpdate,
  AssistantStatus,
  AttachmentView,
  CaptureTarget,
  CaptureTargets,
  DotView,
  FinderStatus,
  PanelView,
} from "./types";

/** Sends a message; events stream to `onEvent` until "done" or "failed". */
/** Sends a message; `voice`: the user spoke it (NOVA answers briefly, to be read aloud). */
export function sendMessage(text: string, voice: boolean, onEvent: (event: AgentEvent) => void): Promise<void> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return callNative<void>("assistant_send", { text, voice, onEvent: channel });
}

/** Warms the AI provider's prompt cache while the user is still speaking. */
export const prewarmAssistant = () => callNative<void>("assistant_prewarm").catch(() => {});

export const cancelRequest = () => callNative<void>("assistant_cancel");
export const answerConfirmation = (id: string, approved: boolean) => callNative<void>("assistant_confirm", { id, approved });
export const resetConversation = () => callNative<void>("assistant_reset");
export const captureTargets = () => callNative<CaptureTargets>("assistant_capture_targets");
export const captureScreen = (target: CaptureTarget) => callNative<AttachmentView[]>("assistant_capture", { target });
export const attachFile = () => callNative<AttachmentView[]>("assistant_attach_file");
export const clearAttachments = () => callNative<void>("assistant_clear_attachments");
export const openPath = (path: string, reveal = false) => callNative<void>("assistant_open_path", { path, reveal });
export const agentStatus = () => callNative<AgentStatus>("assistant_agent_status");
export const configureAgent = (prefs: AgentPrefs) => callNative<AgentStatus>("assistant_agent_configure", { prefs });
export const actionHistory = (limit = 100) => callNative<ActionEntry[]>("assistant_actions", { limit });
export const clearHistory = () => callNative<void>("assistant_clear_history");

export const finderStatus = () => callNative<FinderStatus>("finder_status");
export const finderPickFolder = () => callNative<FinderStatus>("finder_pick_folder");
export const finderAddStandardFolders = () => callNative<FinderStatus>("finder_add_standard_folders");
export const finderRemoveFolder = (path: string) => callNative<FinderStatus>("finder_remove_folder", { path });
export const finderSetContent = (enabled: boolean) => callNative<FinderStatus>("finder_set_content", { enabled });
export const finderReindex = () => callNative<FinderStatus>("finder_reindex");

export const assistantStatus = () => callNative<AssistantStatus>("assistant_status");
export const configureAssistant = (update: AssistantPrefsUpdate) => callNative<AssistantStatus>("assistant_configure", { update });
export const resetDotPosition = () => callNative<AssistantStatus>("assistant_reset_position");

/** Opens or closes the panel. */
export const toggleAssistant = () => callNative<void>("assistant_toggle");
/** Asks the panel to animate out; it reports back with `panelHidden`. */
export const collapseAssistant = () => callNative<void>("assistant_collapse");
export const panelHidden = (generation: number) => callNative<void>("assistant_panel_hidden", { generation });

export const dotReady = () => callNative<DotView>("assistant_dot_ready");
export const panelReady = () => callNative<PanelView>("assistant_panel_ready");
export const openDotMenu = () => callNative<void>("assistant_dot_menu");
/** Shows NOVA's main window, optionally at Settings → NOVA AI assistant or AI providers. */
export const openNova = (section?: "assistant" | "ai" | "productivity") => callNative<void>("assistant_open_main", { section: section ?? null });
export const openWebPage = (url: string) => callNative<void>("open_url", { url });
