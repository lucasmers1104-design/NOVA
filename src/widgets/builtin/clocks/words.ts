export type WordClockLanguage = "de" | "en";

/**
 * Asks the system locale directly: `uiLocale()` maps every non-English system
 * to en-GB for NOVA's English UI, so it can never report German.
 */
export function wordClockLanguage(locale: string = typeof navigator === "undefined" ? "" : navigator.language): WordClockLanguage {
  return locale.toLowerCase().startsWith("de") ? "de" : "en";
}

const GERMAN_HOURS = ["zwölf", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf"];
const ENGLISH_HOURS = ["twelve", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"];

function germanText(minutes: number, hour: string, next: string): string {
  if (minutes === 0) return `${hour === "eins" ? "ein" : hour} Uhr`;
  if (minutes <= 2) return `kurz nach ${hour}`;
  if (minutes <= 7) return `fünf nach ${hour}`;
  if (minutes <= 12) return `zehn nach ${hour}`;
  if (minutes <= 17) return `Viertel nach ${hour}`;
  if (minutes <= 22) return `zwanzig nach ${hour}`;
  // German names the half hour after the coming hour: 9:30 is "halb zehn".
  if (minutes <= 27) return `fünf vor halb ${next}`;
  if (minutes <= 29) return `kurz vor halb ${next}`;
  if (minutes === 30) return `halb ${next}`;
  if (minutes <= 32) return `kurz nach halb ${next}`;
  if (minutes <= 37) return `fünf nach halb ${next}`;
  if (minutes <= 42) return `zwanzig vor ${next}`;
  if (minutes <= 47) return `Viertel vor ${next}`;
  if (minutes <= 52) return `zehn vor ${next}`;
  if (minutes <= 57) return `fünf vor ${next}`;
  return `kurz vor ${next}`;
}

function englishText(minutes: number, hour: string, next: string): string {
  if (minutes === 0) return `${hour} o'clock`;
  if (minutes <= 2) return `just after ${hour}`;
  if (minutes <= 7) return `five past ${hour}`;
  if (minutes <= 12) return `ten past ${hour}`;
  if (minutes <= 17) return `quarter past ${hour}`;
  if (minutes <= 22) return `twenty past ${hour}`;
  if (minutes <= 27) return `twenty-five past ${hour}`;
  if (minutes <= 29) return `almost half past ${hour}`;
  if (minutes === 30) return `half past ${hour}`;
  if (minutes <= 32) return `just after half past ${hour}`;
  if (minutes <= 37) return `twenty-five to ${next}`;
  if (minutes <= 42) return `twenty to ${next}`;
  if (minutes <= 47) return `quarter to ${next}`;
  if (minutes <= 52) return `ten to ${next}`;
  if (minutes <= 57) return `five to ${next}`;
  return `almost ${next}`;
}

/**
 * The time as spoken, to the nearest five minutes. Spoken time is always on a
 * twelve-hour dial in both languages, whatever the 24-hour setting says.
 */
export function wordClockText(hours: number, minutes: number, language: WordClockLanguage): string {
  const names = language === "de" ? GERMAN_HOURS : ENGLISH_HOURS;
  const hour = names[hours % 12]!;
  const next = names[(hours + 1) % 12]!;
  return language === "de" ? `Es ist ${germanText(minutes, hour, next)}` : `It's ${englishText(minutes, hour, next)}`;
}
