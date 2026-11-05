/**
 * Turns written German into words NOVA's voice can read naturally: times,
 * dates, amounts, units, numbers, abbreviations and symbols. Used only for
 * NOVA's own German voices (Windows voices do this themselves).
 */

const ONES = ["", "ein", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun"];
const TEENS = ["zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"];
const TENS = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"];
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function below100(n: number): string {
  if (n < 10) return ONES[n]!;
  if (n < 20) return TEENS[n - 10]!;
  const one = n % 10;
  return one ? `${ONES[one]}und${TENS[Math.floor(n / 10)]}` : TENS[Math.floor(n / 10)]!;
}

function below1000(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return (hundreds ? `${hundreds === 1 ? "" : ONES[hundreds]}hundert` : "") + below100(rest);
}

/** A whole number in words: 21 → "einundzwanzig", 1 → "eins", 2_500_000 → "zwei Millionen fünfhunderttausend". */
export function numberWords(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (value < 0) return `minus ${numberWords(-value)}`;
  const n = Math.floor(value);
  if (n === 0) return "null";
  if (n >= 1e12) return String(n).split("").map((d) => numberWords(Number(d))).join(" ");
  const parts: string[] = [];
  const billions = Math.floor(n / 1e9);
  const millions = Math.floor((n % 1e9) / 1e6);
  const thousands = Math.floor((n % 1e6) / 1e3);
  const rest = n % 1000;
  if (billions) parts.push(billions === 1 ? "eine Milliarde" : `${below1000(billions)} Milliarden`);
  if (millions) parts.push(millions === 1 ? "eine Million" : `${below1000(millions)} Millionen`);
  let small = "";
  if (thousands) small += `${thousands === 1 ? "" : below1000(thousands)}tausend`;
  if (rest) small += below1000(rest);
  if (small) parts.push(small);
  let words = parts.join(" ");
  // A number ending in 1 is said "eins" ("hunderteins"), but not in "einundzwanzig".
  if (rest % 100 === 1) words += "s";
  return words;
}

/** Years 1100–1999 are said in hundreds: "neunzehnhundertneunundneunzig". */
function yearWords(year: number): string {
  if (year >= 1100 && year < 2000) {
    const rest = year % 100;
    return `${below100(Math.floor(year / 100))}hundert${rest ? below100(rest) + (rest === 1 ? "s" : "") : ""}`;
  }
  return numberWords(year);
}

/** "erste", "dritte", "zwanzigste" (stem without the ending). */
function ordinalStem(n: number): string {
  if (n === 1) return "erst";
  if (n === 3) return "dritt";
  if (n === 7) return "siebt";
  if (n === 8) return "acht";
  const words = numberWords(n).replace(/s$/, "");
  return n < 20 ? `${words}t` : `${words}st`;
}

/** Day of a date, inflected for what comes before it: "am dritten", "der dritte", "dritter". */
function dayWords(day: number, before: string): string {
  const ending = DATIVE_BEFORE.test(before) ? "en" : ARTICLE_BEFORE.test(before) ? "e" : "er";
  return ordinalStem(day) + ending;
}

const ARTICLE_BEFORE = /(?:\b(?:der|die|das)\s+)$/i;

const DATIVE_BEFORE = /(?:\b(?:am|vom|zum|seit dem|bis zum|ab dem|bis|den|dem|ab)\s+)$/i;

/** A written number ("1.234,5", "2,50", "3") as a value, or null. */
function parseNumber(text: string): number | null {
  let t = text.replace(/\s/g, "");
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "");
  else if (/^\d+\.\d{1,2}$/.test(t)) t = t.replace(".", ","); // English decimal point
  t = t.replace(",", ".");
  const value = Number(t);
  return Number.isFinite(value) ? value : null;
}

/** "1,5" → "eins Komma fünf", "3" → "drei"; digits after the comma one by one. */
function decimalWords(text: string): string {
  let t = text.replace(/\s/g, "");
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "");
  else if (/^\d+\.\d{1,2}$/.test(t)) t = t.replace(".", ",");
  const [whole, fraction] = t.split(",");
  const head = numberWords(Number(whole));
  if (!fraction) return head;
  return `${head} Komma ${fraction.split("").map((d) => numberWords(Number(d))).join(" ")}`;
}

const FEMININE_NOUN = /(e|ung|heit|keit|ion|tät|schaft|ik|ei|ur|in|enz|anz)$/;
const NUM = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?`;

/** Units after a number: [one, several]. */
const UNITS: [string, string, string][] = [
  ["km/h", "Kilometer pro Stunde", "Kilometer pro Stunde"],
  ["Mbit/s", "Megabit pro Sekunde", "Megabit pro Sekunde"],
  ["MB/s", "Megabyte pro Sekunde", "Megabyte pro Sekunde"],
  ["kWh", "Kilowattstunde", "Kilowattstunden"],
  ["°C", "Grad Celsius", "Grad Celsius"],
  ["°F", "Grad Fahrenheit", "Grad Fahrenheit"],
  ["°", "Grad", "Grad"],
  ["GHz", "Gigahertz", "Gigahertz"],
  ["MHz", "Megahertz", "Megahertz"],
  ["Hz", "Hertz", "Hertz"],
  ["TB", "Terabyte", "Terabyte"],
  ["GB", "Gigabyte", "Gigabyte"],
  ["MB", "Megabyte", "Megabyte"],
  ["KB", "Kilobyte", "Kilobyte"],
  ["kB", "Kilobyte", "Kilobyte"],
  ["km", "Kilometer", "Kilometer"],
  ["cm", "Zentimeter", "Zentimeter"],
  ["mm", "Millimeter", "Millimeter"],
  ["kg", "Kilogramm", "Kilogramm"],
  ["ml", "Milliliter", "Milliliter"],
  ["kW", "Kilowatt", "Kilowatt"],
  ["ms", "Millisekunde", "Millisekunden"],
  ["min", "Minute", "Minuten"],
  ["Std.", "Stunde", "Stunden"],
  ["fps", "Bild pro Sekunde", "Bilder pro Sekunde"],
  ["px", "Pixel", "Pixel"],
  ["m", "Meter", "Meter"],
  ["g", "Gramm", "Gramm"],
  ["l", "Liter", "Liter"],
  ["h", "Stunde", "Stunden"],
  ["s", "Sekunde", "Sekunden"],
  ["W", "Watt", "Watt"],
];

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bz\.\s?B\./g, "zum Beispiel"],
  [/\bd\.\s?h\./g, "das heißt"],
  [/\bu\.\s?a\./g, "unter anderem"],
  [/\bu\.\s?U\./g, "unter Umständen"],
  [/\bo\.\s?Ä\./g, "oder Ähnliches"],
  [/\bi\.\s?d\.\s?R\./g, "in der Regel"],
  [/\bbzw\./g, "beziehungsweise"],
  [/\bca\./g, "circa"],
  [/\busw\./g, "und so weiter"],
  [/\betc\./g, "et cetera"],
  [/\bvgl\./g, "vergleiche"],
  [/\bggf\./g, "gegebenenfalls"],
  [/\bevtl\./g, "eventuell"],
  [/\binkl\./g, "inklusive"],
  [/\bzzgl\./g, "zuzüglich"],
  [/\bbspw\./g, "beispielsweise"],
  [/\bsog\./g, "sogenannte"],
  [/\bbzgl\./g, "bezüglich"],
  [/\binsb\./g, "insbesondere"],
  [/\bmax\./g, "maximal"],
  [/\bmind\./g, "mindestens"],
  [/\bNr\./g, "Nummer"],
  [/\bDr\./g, "Doktor"],
  [/\bProf\./g, "Professor"],
  [/\bStr\./g, "Straße"],
  [/\bJh\./g, "Jahrhundert"],
  [/\bMio\./g, "Millionen"],
  [/\bMrd\./g, "Milliarden"],
  [/\bTsd\./g, "Tausend"],
  [/\bTel\./g, "Telefon"],
];

/** Short acronyms read letter by letter. */
const SPELLED = ["PDF", "USB", "CPU", "GPU", "KI", "PC", "URL", "API", "ID", "SSD", "HDD", "CSV", "HTML", "XML", "JSON", "PNG", "JPG", "MP3", "MP4", "DNS", "IP", "VPN", "TV", "EU", "USA", "BMW", "ZIP", "SMS", "FAQ", "AI", "UI"];
const SPOKEN_AS: Record<string, string> = { NOVA: "Nova", OK: "okay", WLAN: "Weh-Lan", RAM: "Ramm", LAN: "Lan", WhatsApp: "Wotsepp", YouTube: "Jutjub", Google: "Gugel" };

function unitPattern(unit: string): string {
  return unit.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Reads `text` (German) the way a person would say it. */
export function normalizeGerman(input: string): string {
  let t = ` ${input} `;

  // Links and addresses.
  t = t.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, "Link");
  t = t.replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, "E-Mail-Adresse");

  // Times: "14:30 Uhr", "14.30 Uhr", "9:05".
  t = t.replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)(\s*Uhr)?\b(?![.,:]\d)/g, (match, h: string, m: string, uhr: string | undefined, offset: number, whole: string) => {
    // "1.234" or a decimal ("2.50") without "Uhr" is not a time unless written with ":".
    if (!uhr && match.includes(".")) return match;
    if (!uhr && whole[offset - 1] && /\d/.test(whole[offset - 1]!)) return match;
    const hour = Number(h);
    const minute = Number(m);
    const hourWords = hour === 1 ? "ein" : numberWords(hour);
    return minute ? `${hourWords} Uhr ${numberWords(minute)}` : `${hourWords} Uhr`;
  });
  t = t.replace(/\b1\s+Uhr\b/g, "ein Uhr");

  // Dates: "03.11.2026", "3.11.", "3. November 2026".
  t = t.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?!\d)/g, (match, d: string, m: string, y: string | undefined, offset: number, whole: string) => {
    const day = Number(d);
    const month = Number(m);
    if (day < 1 || day > 31 || month < 1 || month > 12) return match;
    let words = `${dayWords(day, whole.slice(Math.max(0, offset - 12), offset))} ${MONTHS[month - 1]}`;
    if (y) words += ` ${yearWords(y.length === 2 ? 2000 + Number(y) : Number(y))}`;
    return words;
  });
  t = t.replace(new RegExp(String.raw`\b(\d{1,2})\.\s+(${MONTHS.join("|")})(?:\s+(\d{4}))?`, "g"), (match, d: string, month: string, y: string | undefined, offset: number, whole: string) => {
    const day = Number(d);
    if (day < 1 || day > 31) return match;
    return `${dayWords(day, whole.slice(Math.max(0, offset - 12), offset))} ${month}${y ? ` ${yearWords(Number(y))}` : ""}`;
  });

  // Versions and other dotted numbers: "1.4.1" → "eins Punkt vier Punkt eins".
  t = t.replace(/(?<![\p{L}\d])\d+(?:\.\d+){2,}(?![\p{L}\d])/gu, (match) => match.split(".").map((p) => numberWords(Number(p))).join(" Punkt "));

  // Money: "12,50 €", "€12,50", "0,99 €", "5 EUR", "$3".
  const money = (amount: string, unit: "Euro" | "Dollar", small: "Cent" | "Cent") => {
    const value = parseNumber(amount);
    if (value === null) return amount;
    const whole = Math.floor(value + 1e-9);
    const cents = Math.round((value - whole) * 100);
    if (whole === 0 && cents) return `${numberWords(cents)} ${small}`;
    const head = whole === 1 ? `ein ${unit}` : `${numberWords(whole)} ${unit}`;
    return cents ? `${head} ${numberWords(cents)}` : head;
  };
  t = t.replace(new RegExp(String.raw`(${NUM})\s?(€|EUR\b|Euro\b)`, "g"), (_, amount: string) => money(amount, "Euro", "Cent"));
  t = t.replace(new RegExp(String.raw`(?:€|EUR)\s?(${NUM})`, "g"), (_, amount: string) => money(amount, "Euro", "Cent"));
  t = t.replace(new RegExp(String.raw`(${NUM})\s?(\$|USD\b|Dollar\b)`, "g"), (_, amount: string) => money(amount, "Dollar", "Cent"));
  t = t.replace(new RegExp(String.raw`(?:\$|USD)\s?(${NUM})`, "g"), (_, amount: string) => money(amount, "Dollar", "Cent"));

  // Percent.
  t = t.replace(new RegExp(String.raw`(${NUM})\s?(%|Prozent\b)`, "g"), (_, value: string) => `${decimalWords(value)} Prozent`);

  // Resolutions and "3x".
  t = t.replace(/\b(\d+)\s?[x×]\s?(\d+)\b/g, (_, a: string, b: string) => `${numberWords(Number(a))} mal ${numberWords(Number(b))}`);
  t = t.replace(/\b(\d+)\s?x\b/g, (_, a: string) => `${numberWords(Number(a)).replace(/s$/, "")}mal`);

  // Ranges and negative numbers.
  t = t.replace(new RegExp(String.raw`(?<![\p{L}\d.,])(${NUM})\s?[–—-]\s?(${NUM})(?![\p{L}\d])`, "gu"), (_, a: string, b: string) => `${a} bis ${b}`);
  t = t.replace(new RegExp(String.raw`(^|[\s(])[-−](${NUM})(?![\p{L}\d])`, "gu"), (_, before: string, value: string) => `${before}minus ${value}`);

  // Fractions.
  t = t.replace(/½/g, " einhalb").replace(/¼/g, " ein Viertel").replace(/¾/g, " drei Viertel");
  t = t.replace(/\b1\/2\b/g, "einhalb").replace(/\b1\/4\b/g, "ein Viertel").replace(/\b3\/4\b/g, "drei Viertel");

  // Units.
  for (const [unit, one, several] of UNITS) {
    const pattern = new RegExp(String.raw`(?<![\p{L}\d.,])(${NUM})\s?${unitPattern(unit)}(?![\p{L}\d/])`, "gu");
    t = t.replace(pattern, (_, value: string) => {
      const v = parseNumber(value);
      if (v === 1) return `${/e$/.test(one) ? "eine" : "ein"} ${one}`;
      return `${decimalWords(value)} ${several}`;
    });
  }

  // Abbreviations (before numbers, so "Nr. 5" → "Nummer fünf").
  for (const [pattern, words] of ABBREVIATIONS) t = t.replace(pattern, words);

  // Years in running text: "im Jahr 1998", "seit 1990".
  t = t.replace(/(?<![\p{L}\d.,])(1[1-9]\d\d)(?![\p{L}\d.,])/gu, (_, y: string) => yearWords(Number(y)));

  // "1 Datei" → "eine Datei", "1 Ordner" → "ein Ordner".
  t = t.replace(/(?<![\p{L}\d.,])1\s+(\p{Lu}\p{Ll}+)/gu, (_, noun: string) => `${FEMININE_NOUN.test(noun) ? "eine" : "ein"} ${noun}`);

  // All other numbers.
  t = t.replace(new RegExp(String.raw`(?<![\p{L}\d.,])(${NUM})(?![\p{L}\d])`, "gu"), (match: string) => decimalWords(match));

  // Symbols.
  t = t.replace(/\s&\s/g, " und ");
  t = t.replace(/\s\+\s/g, " plus ");
  t = t.replace(/\s=\s/g, " gleich ");
  t = t.replace(/~\s?(?=\S)/g, "circa ");
  t = t.replace(/#(?=\d|\s?\p{L})/gu, "Nummer ");
  t = t.replace(/\s*(→|->|=>|⇒)\s*/g, ", ");
  t = t.replace(/\bund\/oder\b/g, "und oder");
  t = t.replace(/(\p{L})\/(\p{L})/gu, "$1 oder $2");
  t = t.replace(/[*_`#|<>\[\]{}]/g, " ");

  // Acronyms and names.
  for (const word of SPELLED) t = t.replace(new RegExp(String.raw`\b${word}s?\b`, "g"), (m) => word.split("").join(" ") + (m.endsWith("s") && m !== word ? "s" : ""));
  for (const [word, spoken] of Object.entries(SPOKEN_AS)) t = t.replace(new RegExp(String.raw`\b${word}\b`, "g"), spoken);

  return t.replace(/\s+([,.!?;:])/g, "$1").replace(/\s+/g, " ").trim();
}
