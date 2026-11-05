import { describe, expect, it } from "vitest";
import { normalizeGerman, numberWords } from "./normalize.de";
import { SentenceSegmenter } from "./segment";

/** Feeds `text` in small pieces, like a streamed reply. */
function stream(text: string, size = 3, options = {}): string[] {
  const segmenter = new SentenceSegmenter(options);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...segmenter.push(text.slice(i, i + size)));
  out.push(...segmenter.finish());
  return out;
}

describe("SentenceSegmenter", () => {
  it("hands out sentences as soon as the next one starts", () => {
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push("Klar, das mache ich.")).toEqual([]);
    expect(segmenter.push(" Ich")).toEqual(["Klar, das mache ich."]);
    expect(segmenter.push(" suche jetzt nach deinen Dateien.")).toEqual([]);
    expect(segmenter.finish()).toEqual(["Ich suche jetzt nach deinen Dateien."]);
  });

  it("keeps abbreviations, ordinals, decimals and versions together", () => {
    expect(stream("Nimm z. B. den Ordner vom 3. Mai mit 2,5 GB. Danach ist v1.4.1 dran.")).toEqual([
      "Nimm z. B. den Ordner vom 3. Mai mit 2,5 GB.",
      "Danach ist v1.4.1 dran.",
    ]);
    expect(stream("Das kostet ca. drei Euro, inkl. Versand usw. und mehr. Okay?")).toEqual(["Das kostet ca. drei Euro, inkl. Versand usw. und mehr.", "Okay?"]);
    expect(stream("Siehe example.com/test.html für Details. Fertig.")).toEqual(["Siehe example.com/test.html für Details.", "Fertig."]);
  });

  it("ends a sentence at question and exclamation marks and line breaks", () => {
    expect(stream("Wirklich? Ja! Das stimmt.\nNeue Zeile ohne Punkt\nUnd noch eine")).toEqual([
      "Wirklich?",
      "Ja! Das stimmt.",
      "Neue Zeile ohne Punkt",
      "Und noch eine",
    ]);
  });

  it("reads list items one by one and skips tables", () => {
    expect(stream("Ich habe drei Treffer gefunden:\n1. Rechnung März\n2. Rechnung April\n| A | B |\n|---|---|\n- Notizen.txt")).toEqual([
      "Ich habe drei Treffer gefunden:",
      "1. Rechnung März",
      "2. Rechnung April",
      "- Notizen.txt",
    ]);
  });

  it("leaves code out and mentions it once", () => {
    const pieces = stream("Hier ist das Skript:\n```python\nprint('hi. Du.')\n```\nUnd so geht es weiter.\n```\nmehr()\n```", 4, { codeNote: "Den Code findest du im Chat." });
    expect(pieces).toEqual(["Hier ist das Skript:", "Den Code findest du im Chat.", "Und so geht es weiter."]);
  });

  it("cuts a long first sentence at a comma so NOVA starts early", () => {
    const long = "Ich habe mir deine Downloads angesehen und dabei festgestellt, dass dort sehr viele alte Installationsdateien liegen, die du wahrscheinlich nicht mehr brauchst.";
    const pieces = stream(long, 5);
    expect(pieces[0]).toMatch(/festgestellt,$/);
    expect(pieces.join(" ")).toBe(long);
    expect(pieces[0]!.length).toBeLessThanOrEqual(100);
  });

  it("joins very short later sentences with the next one", () => {
    expect(stream("Okay. Gut. Das ist alles für heute, bis bald.")).toEqual(["Okay.", "Gut. Das ist alles für heute, bis bald."]);
  });

  it("treats a tool start as the end of what came before", () => {
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push("Ich schaue mir das kurz an")).toEqual([]);
    expect(segmenter.boundary()).toEqual(["Ich schaue mir das kurz an"]);
    expect(segmenter.push("Gefunden.")).toEqual([]);
    expect(segmenter.finish()).toEqual(["Gefunden."]);
  });

  it("never loses text, whatever the chunk size", () => {
    const text = "Dein Rechner ist gerade gut ausgelastet. Am meisten braucht der Browser mit 23 % der CPU, danach NOVA mit 4 %. Der Arbeitsspeicher ist zu 71 % belegt, also 5,6 GB von 7,9 GB.";
    for (const size of [1, 2, 7, 50, 1000]) expect(stream(text, size).join(" ")).toBe(text);
  });
});

describe("numberWords", () => {
  it.each([
    [0, "null"],
    [1, "eins"],
    [7, "sieben"],
    [16, "sechzehn"],
    [21, "einundzwanzig"],
    [99, "neunundneunzig"],
    [100, "hundert"],
    [101, "hunderteins"],
    [234, "zweihundertvierunddreißig"],
    [1000, "tausend"],
    [1001, "tausendeins"],
    [2026, "zweitausendsechsundzwanzig"],
    [123_456, "hundertdreiundzwanzigtausendvierhundertsechsundfünfzig"],
    [1_000_000, "eine Million"],
    [2_500_000, "zwei Millionen fünfhunderttausend"],
    [3_000_000_000, "drei Milliarden"],
    [-4, "minus vier"],
  ])("%d → %s", (n, words) => expect(numberWords(n)).toBe(words));
});

describe("normalizeGerman", () => {
  it.each([
    ["Um 14:30 Uhr geht es los.", "Um vierzehn Uhr dreißig geht es los."],
    ["Der Termin ist um 9:05.", "Der Termin ist um neun Uhr fünf."],
    ["Ab 8.00 Uhr bin ich da.", "Ab acht Uhr bin ich da."],
    ["Um 1 Uhr nachts.", "Um ein Uhr nachts."],
    ["Heute ist der 03.11.2026.", "Heute ist der dritte November zweitausendsechsundzwanzig."],
    ["Termin: 3.11.2026", "Termin: dritter November zweitausendsechsundzwanzig"],
    ["Am 3.11. habe ich frei.", "Am dritten November habe ich frei."],
    ["Bis zum 24. Dezember 2026.", "Bis zum vierundzwanzigsten Dezember zweitausendsechsundzwanzig."],
    ["Das kostet 12,50 €.", "Das kostet zwölf Euro fünfzig."],
    ["Nur 0,99 € im Monat.", "Nur neunundneunzig Cent im Monat."],
    ["Preis: €1.299,00", "Preis: tausendzweihundertneunundneunzig Euro"],
    ["Es sind 5 EUR.", "Es sind fünf Euro."],
    ["Das macht 1 €.", "Das macht ein Euro."],
    ["Die CPU ist zu 23 % ausgelastet.", "Die C P U ist zu dreiundzwanzig Prozent ausgelastet."],
    ["Belegt sind 5,6 GB von 7,9 GB.", "Belegt sind fünf Komma sechs Gigabyte von sieben Komma neun Gigabyte."],
    ["Draußen sind es 21 °C.", "Draußen sind es einundzwanzig Grad Celsius."],
    ["Das dauert 1 min.", "Das dauert eine Minute."],
    ["Das dauert 15 min.", "Das dauert fünfzehn Minuten."],
    ["Er fährt 120 km/h.", "Er fährt hundertzwanzig Kilometer pro Stunde."],
    ["Die Datei hat 1.234 Zeilen.", "Die Datei hat tausendzweihundertvierunddreißig Zeilen."],
    ["Ich habe 1 Datei gefunden.", "Ich habe eine Datei gefunden."],
    ["Ich habe 1 Ordner gefunden.", "Ich habe ein Ordner gefunden."],
    ["Es gibt 3 Treffer.", "Es gibt drei Treffer."],
    ["Das sind 10–20 Minuten.", "Das sind zehn bis zwanzig Minuten."],
    ["Es hat -5 Grad.", "Es hat minus fünf Grad."],
    ["Ein Bildschirm mit 1920x1080.", "Ein Bildschirm mit tausendneunhundertzwanzig mal tausendachtzig."],
    ["Drück 3x die Taste.", "Drück dreimal die Taste."],
    ["NOVA 1.4.1 ist installiert.", "Nova eins Punkt vier Punkt eins ist installiert."],
    ["Z. B. so, d. h. ganz einfach, bzw. schneller.", "Z. B. so, das heißt ganz einfach, beziehungsweise schneller."],
    ["Das ist z. B. gut, ca. 5 Stück, usw.", "Das ist zum Beispiel gut, circa fünf Stück, und so weiter"],
    ["Siehe Nr. 7.", "Siehe Nummer sieben."],
    ["Öffne https://example.com/x?y=1 bitte.", "Öffne Link bitte."],
    ["Schreib an max@example.com.", "Schreib an E-Mail-Adresse."],
    ["Speicher die PDF als Datei & schick sie.", "Speicher die P D F als Datei und schick sie."],
    ["Das WLAN ist OK.", "Das Weh-Lan ist okay."],
    ["Im Jahr 1998 war das anders.", "Im Jahr neunzehnhundertachtundneunzig war das anders."],
    ["Ein halber Liter: ½ l", "Ein halber Liter: einhalb l"],
    ["Bilder/Videos und/oder Musik", "Bilder oder Videos und oder Musik"],
    ["Version 2.5 ist neu.", "Version zwei Komma fünf ist neu."],
    ["Windows 11 läuft.", "Windows elf läuft."],
    ["Der i3-6006U bleibt so.", "Der i3-6006U bleibt so."],
  ])("%s", (input, expected) => expect(normalizeGerman(input)).toBe(expected));
});
