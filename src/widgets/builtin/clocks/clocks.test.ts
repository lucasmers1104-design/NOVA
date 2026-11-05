import { describe, expect, it } from "vitest";
import { clockParts, handAngles, wallClock } from "./time";
import { wordClockLanguage, wordClockText } from "./words";

describe("German word clock", () => {
  const de = (hours: number, minutes: number) => wordClockText(hours, minutes, "de");

  it("names the half hour after the coming hour", () => {
    expect(de(9, 30)).toBe("Es ist halb zehn");
    expect(de(21, 30)).toBe("Es ist halb zehn");
    expect(de(12, 30)).toBe("Es ist halb eins");
    expect(de(0, 30)).toBe("Es ist halb eins");
    expect(de(11, 30)).toBe("Es ist halb zwölf");
    expect(de(23, 30)).toBe("Es ist halb zwölf");
  });

  it("says quarter past and quarter to across the hour rollover", () => {
    expect(de(3, 15)).toBe("Es ist Viertel nach drei");
    expect(de(0, 15)).toBe("Es ist Viertel nach zwölf");
    expect(de(2, 45)).toBe("Es ist Viertel vor drei");
    expect(de(12, 45)).toBe("Es ist Viertel vor eins");
    expect(de(23, 45)).toBe("Es ist Viertel vor zwölf");
  });

  it("says shortly after and shortly before at the rollover", () => {
    expect(de(0, 1)).toBe("Es ist kurz nach zwölf");
    expect(de(1, 2)).toBe("Es ist kurz nach eins");
    expect(de(23, 58)).toBe("Es ist kurz vor zwölf");
    expect(de(12, 59)).toBe("Es ist kurz vor eins");
    expect(de(9, 29)).toBe("Es ist kurz vor halb zehn");
    expect(de(9, 31)).toBe("Es ist kurz nach halb zehn");
  });

  it("drops the s of eins before Uhr", () => {
    expect(de(1, 0)).toBe("Es ist ein Uhr");
    expect(de(13, 0)).toBe("Es ist ein Uhr");
    expect(de(0, 0)).toBe("Es ist zwölf Uhr");
    expect(de(15, 0)).toBe("Es ist drei Uhr");
  });

  it("rounds to five minutes around the half hour", () => {
    expect(de(9, 25)).toBe("Es ist fünf vor halb zehn");
    expect(de(9, 35)).toBe("Es ist fünf nach halb zehn");
    expect(de(9, 20)).toBe("Es ist zwanzig nach neun");
    expect(de(9, 40)).toBe("Es ist zwanzig vor zehn");
    expect(de(9, 7)).toBe("Es ist fünf nach neun");
    expect(de(9, 8)).toBe("Es ist zehn nach neun");
  });
});

describe("English word clock", () => {
  const en = (hours: number, minutes: number) => wordClockText(hours, minutes, "en");

  it("keeps the current hour through half past", () => {
    expect(en(9, 30)).toBe("It's half past nine");
    expect(en(21, 15)).toBe("It's quarter past nine");
    expect(en(9, 25)).toBe("It's twenty-five past nine");
  });

  it("rolls over to the coming hour after half past", () => {
    expect(en(9, 35)).toBe("It's twenty-five to ten");
    expect(en(23, 45)).toBe("It's quarter to twelve");
    expect(en(12, 50)).toBe("It's ten to one");
    expect(en(23, 58)).toBe("It's almost twelve");
  });

  it("reads whole hours on a twelve-hour dial", () => {
    expect(en(0, 0)).toBe("It's twelve o'clock");
    expect(en(13, 0)).toBe("It's one o'clock");
    expect(en(1, 2)).toBe("It's just after one");
  });

  it("picks the language from the system locale", () => {
    expect(wordClockLanguage("de-DE")).toBe("de");
    expect(wordClockLanguage("de")).toBe("de");
    expect(wordClockLanguage("en-GB")).toBe("en");
    expect(wordClockLanguage("fr-FR")).toBe("en");
  });
});

describe("analog hand angles", () => {
  it("points at the marks on the hour", () => {
    expect(handAngles({ hours: 0, minutes: 0, seconds: 0 })).toEqual({ hour: 0, minute: 0, second: 0 });
    expect(handAngles({ hours: 12, minutes: 0, seconds: 0 }).hour).toBe(0);
    expect(handAngles({ hours: 3, minutes: 0, seconds: 0 }).hour).toBe(90);
    expect(handAngles({ hours: 15, minutes: 0, seconds: 0 }).hour).toBe(90);
  });

  it("moves the hour hand between marks with the minutes", () => {
    const angles = handAngles({ hours: 6, minutes: 30, seconds: 0 });
    expect(angles.hour).toBe(195);
    expect(angles.minute).toBe(180);
  });

  it("sweeps the minute hand with the seconds", () => {
    const angles = handAngles({ hours: 23, minutes: 59, seconds: 30 });
    expect(angles.second).toBe(180);
    expect(angles.minute).toBeCloseTo(357);
    expect(angles.hour).toBeCloseTo(359.75);
  });
});

describe("clock time helpers", () => {
  const date = new Date("2026-01-15T17:05:09Z");

  it("reads the wall clock of another time zone", () => {
    expect(wallClock(date, "Asia/Tokyo")).toEqual({ hours: 2, minutes: 5, seconds: 9 });
    expect(wallClock(date, "Asia/Kolkata")).toEqual({ hours: 22, minutes: 35, seconds: 9 });
  });

  it("uses local time without a zone", () => {
    expect(wallClock(date)).toEqual({ hours: date.getHours(), minutes: date.getMinutes(), seconds: date.getSeconds() });
  });

  it("formats parts in a zone, honoring the 24-hour setting", () => {
    expect(clockParts(date, true, "en-GB", "Asia/Tokyo")).toMatchObject({ time: "02:05", hour: "02", minute: "05", period: null });
    expect(clockParts(date, false, "en-GB", "Europe/London")).toMatchObject({ time: "5:05", hour: "5", minute: "05", period: "PM" });
  });
});
