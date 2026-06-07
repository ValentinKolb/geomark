import { describe, test, expect } from "bun:test";
import { countryFlagEmoji } from "../../src/lib/flag";

describe("countryFlagEmoji", () => {
  test("known country codes produce expected flag emojis", () => {
    expect(countryFlagEmoji("DE")).toBe("🇩🇪");
    expect(countryFlagEmoji("US")).toBe("🇺🇸");
    expect(countryFlagEmoji("FR")).toBe("🇫🇷");
    expect(countryFlagEmoji("JP")).toBe("🇯🇵");
  });

  test("lowercase input is normalized", () => {
    expect(countryFlagEmoji("de")).toBe("🇩🇪");
  });

  test("non-2-letter input returns empty string", () => {
    expect(countryFlagEmoji("DEU")).toBe("");
    expect(countryFlagEmoji("D")).toBe("");
    expect(countryFlagEmoji("")).toBe("");
  });

  test("non-letter characters return empty string", () => {
    expect(countryFlagEmoji("12")).toBe("");
    expect(countryFlagEmoji("D!")).toBe("");
  });
});
