// Dictation with the phone's own speech recognition, in the phone's language.
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useCallback, useState } from "react";

export function useDictation(onText: (text: string, final: boolean) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useSpeechRecognitionEvent("start", () => setListening(true));
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("result", (event) => {
    const text = event.results[0]?.transcript ?? "";
    if (text) onText(text, event.isFinal);
  });
  useSpeechRecognitionEvent("error", (event) => {
    setListening(false);
    if (event.error !== "aborted" && event.error !== "no-speech") setError("Dein Handy konnte gerade nicht zuhören.");
  });

  const start = useCallback(async () => {
    setError(null);
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setError("Erlaube das Mikrofon in den Einstellungen deines Handys, um zu diktieren.");
      return;
    }
    const lang = Intl.DateTimeFormat().resolvedOptions().locale || "de-DE";
    ExpoSpeechRecognitionModule.start({ lang, interimResults: true, continuous: false });
  }, []);

  const stop = useCallback(() => ExpoSpeechRecognitionModule.stop(), []);

  return { listening, error, start, stop };
}
