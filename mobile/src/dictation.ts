// Dictation with the phone's own speech recognition, in the phone's language.
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useCallback, useEffect, useRef, useState } from "react";

export function useDictation(onText: (text: string, final: boolean) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The recognizer's events reach every screen that uses this hook, and tabs stay
  // mounted behind a dialog. Only the one that started listening may take the words.
  const mine = useRef(false);

  useSpeechRecognitionEvent("start", () => {
    if (mine.current) setListening(true);
  });
  useSpeechRecognitionEvent("end", () => {
    mine.current = false;
    setListening(false);
  });
  useSpeechRecognitionEvent("result", (event) => {
    if (!mine.current) return;
    const text = event.results[0]?.transcript ?? "";
    if (text) onText(text, event.isFinal);
  });
  useSpeechRecognitionEvent("error", (event) => {
    const wasMine = mine.current;
    mine.current = false;
    setListening(false);
    if (wasMine && event.error !== "aborted" && event.error !== "no-speech") setError("Dein Handy konnte gerade nicht zuhören.");
  });

  const start = useCallback(async () => {
    setError(null);
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setError("Erlaube das Mikrofon in den Einstellungen deines Handys, um zu diktieren.");
      return;
    }
    const lang = Intl.DateTimeFormat().resolvedOptions().locale || "de-DE";
    mine.current = true;
    ExpoSpeechRecognitionModule.start({ lang, interimResults: true, continuous: false });
  }, []);

  const stop = useCallback(() => ExpoSpeechRecognitionModule.stop(), []);

  // Leaving the screen mid-sentence must not leave the microphone open.
  useEffect(
    () => () => {
      if (mine.current) ExpoSpeechRecognitionModule.abort();
    },
    [],
  );

  return { listening, error, start, stop };
}
