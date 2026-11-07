import { Channel } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { notify, notifyError } from "@/features/notifications/store";
import { callNative } from "@/lib/native";
import { nativeStorage } from "@/lib/persistence";

export type ProviderId = "openai" | "anthropic" | "gemini";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  keyUrl: string;
  keyHint: string;
  /** Used until the provider's own model list has been fetched. */
  suggestedModels: string[];
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    suggestedModels: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
  },
  { id: "openai", name: "OpenAI", keyUrl: "https://platform.openai.com/api-keys", keyHint: "sk-…", suggestedModels: [] },
  { id: "gemini", name: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey", keyHint: "AIza…", suggestedModels: [] },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id)!;
}

export interface Conversation {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  error: string | null;
  createdAt: number;
}

export type ChatEvent =
  | { type: "started"; conversationId: string; userMessage: ChatMessage }
  | { type: "delta"; text: string }
  | { type: "done"; message: ChatMessage }
  | { type: "failed"; error: string; message: ChatMessage | null };

export type KeyStatus = Record<ProviderId, boolean>;

export const aiKeys = {
  keyStatus: ["ai", "keys"] as const,
  models: (provider: ProviderId) => ["ai", "models", provider] as const,
  conversations: ["ai", "conversations"] as const,
  messages: (id: string) => ["ai", "messages", id] as const,
};

export function useKeyStatus() {
  return useQuery({ queryKey: aiKeys.keyStatus, queryFn: () => callNative<KeyStatus>("ai_key_status"), staleTime: 60_000 });
}

export function useSaveKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, key }: { provider: ProviderId; key: string }) => callNative<void>("ai_key_set", { provider, key }),
    onSuccess: (_, { provider }) => {
      void client.invalidateQueries({ queryKey: aiKeys.keyStatus });
      void client.invalidateQueries({ queryKey: aiKeys.models(provider) });
      // Who answers and which online voices can be used depend on the keys.
      void client.invalidateQueries({ queryKey: ["assistant"] });
      notify(`${providerInfo(provider).name} key saved to Windows Credential Manager`, { kind: "success" });
    },
    onError: (error) => notifyError("Couldn't save the key", error),
  });
}

export function useDeleteKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (provider: ProviderId) => callNative<void>("ai_key_delete", { provider }),
    onSuccess: (_, provider) => {
      void client.invalidateQueries({ queryKey: aiKeys.keyStatus });
      client.removeQueries({ queryKey: aiKeys.models(provider) });
      void client.invalidateQueries({ queryKey: ["assistant"] });
    },
  });
}

export interface ModelInfo {
  id: string;
  name: string;
}

export function useModels(provider: ProviderId, enabled: boolean) {
  return useQuery({
    queryKey: aiKeys.models(provider),
    queryFn: () => callNative<ModelInfo[]>("ai_models", { provider }),
    enabled,
    staleTime: 30 * 60_000,
    retry: false,
  });
}

export function useConversations() {
  return useQuery({ queryKey: aiKeys.conversations, queryFn: () => callNative<Conversation[]>("ai_conversations_list") });
}

export function useMessages(id: string | null) {
  return useQuery({
    queryKey: aiKeys.messages(id ?? ""),
    queryFn: () => callNative<ChatMessage[]>("ai_conversation_messages", { id }),
    enabled: id !== null,
  });
}

interface AiPreferences {
  provider: ProviderId;
  models: Record<ProviderId, string>;
  systemPrompt: string;
  temperature: number | null;
  setProvider: (provider: ProviderId) => void;
  setModel: (provider: ProviderId, model: string) => void;
  setSystemPrompt: (prompt: string) => void;
  setTemperature: (temperature: number | null) => void;
}

export const useAiPreferences = create<AiPreferences>()(
  persist(
    (set) => ({
      provider: "anthropic",
      models: { anthropic: "claude-sonnet-5-5", openai: "", gemini: "" },
      systemPrompt: "",
      temperature: null,
      setProvider: (provider) => set({ provider }),
      setModel: (provider, model) => set((s) => ({ models: { ...s.models, [provider]: model } })),
      setSystemPrompt: (systemPrompt) => set({ systemPrompt: systemPrompt.slice(0, 4000) }),
      setTemperature: (temperature) => set({ temperature }),
    }),
    {
      name: "nova.ai",
      storage: createJSONStorage(() => nativeStorage),
      partialize: (s) => ({ provider: s.provider, models: s.models, systemPrompt: s.systemPrompt, temperature: s.temperature }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AiPreferences>;
        const valid = (id: unknown): id is ProviderId => PROVIDERS.some((x) => x.id === id);
        const modelOk = (m: unknown) => typeof m === "string" && /^[A-Za-z0-9._:/-]{0,120}$/.test(m);
        return {
          ...current,
          provider: valid(p.provider) ? p.provider : current.provider,
          models: {
            anthropic: modelOk(p.models?.anthropic) ? p.models!.anthropic : current.models.anthropic,
            openai: modelOk(p.models?.openai) ? p.models!.openai : current.models.openai,
            gemini: modelOk(p.models?.gemini) ? p.models!.gemini : current.models.gemini,
          },
          systemPrompt: typeof p.systemPrompt === "string" ? p.systemPrompt.slice(0, 4000) : "",
          temperature: typeof p.temperature === "number" && p.temperature >= 0 && p.temperature <= 2 ? p.temperature : null,
        };
      },
    },
  ),
);

export interface StreamHandlers {
  onStarted: (conversationId: string, userMessage: ChatMessage) => void;
  onDelta: (text: string) => void;
  onDone: (message: ChatMessage) => void;
  onFailed: (error: string, message: ChatMessage | null) => void;
}

/** Sends a message and streams the reply. Resolves when the stream has ended. */
export async function streamChat(
  request: { requestId: string; conversationId: string | null; provider: ProviderId; model: string; message: string; systemPrompt: string; temperature: number | null },
  handlers: StreamHandlers,
): Promise<void> {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = (event) => {
    if (event.type === "started") handlers.onStarted(event.conversationId, event.userMessage);
    else if (event.type === "delta") handlers.onDelta(event.text);
    else if (event.type === "done") handlers.onDone(event.message);
    else handlers.onFailed(event.error, event.message);
  };
  await callNative<void>("ai_chat", {
    request: { ...request, systemPrompt: request.systemPrompt || null, temperature: request.temperature, maxTokens: null },
    onEvent: channel,
  });
}

export function cancelChat(requestId: string): Promise<void> {
  return callNative<void>("ai_chat_cancel", { requestId });
}
