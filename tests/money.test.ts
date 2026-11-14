import { describe, expect, it } from "vitest";
import { formatMoney, homeCurrencyDiscrepancies, roundMoney, sumHomeCurrency, sumHomeCurrencyMinor, toMinorUnits } from "../src/pohoda/money.js";

describe("money", () => {
  it("converts exact 2dp values, strings, and float representation noise", () => {
    expect(toMinorUnits(0.1 + 0.2)).toBe(30);
    expect(toMinorUnits(1234.56)).toBe(123456);
    expect(toMinorUnits("1234.5")).toBe(123450);
    expect(toMinorUnits("1234,50")).toBe(123450);
    expect(toMinorUnits("-0.42")).toBe(-42);
    expect(toMinorUnits(-0)).toBe(0);
    expect(toMinorUnits(12345678.91)).toBe(1234567891);
    expect(toMinorUnits(99999999.99)).toBe(9999999999);
    expect(toMinorUnits("10.500")).toBe(1050);
  });

  it("rejects genuine sub-minor precision, including large amounts", () => {
    expect(() => toMinorUnits(10.005)).toThrow(/more than two decimal places/);
    expect(() => toMinorUnits(10000.005)).toThrow(/more than two decimal places/);
    expect(() => toMinorUnits(1000000.001)).toThrow(/more than two decimal places/);
    expect(() => toMinorUnits("10000.005")).toThrow(/more than two decimal places/);
    expect(() => toMinorUnits("1 234")).toThrow(/decimal number/);
    expect(() => toMinorUnits("abc", "total")).toThrow(/total/);
    expect(() => toMinorUnits(Number.NaN)).toThrow(/finite/);
    expect(() => toMinorUnits(Infinity)).toThrow(/finite/);
  });

  it("formats and rounds without float noise", () => {
    expect(formatMoney(0.1 + 0.2)).toBe("0.30");
    expect(formatMoney(-5)).toBe("-5.00");
    expect(formatMoney("-0.05")).toBe("-0.05");
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
  });

  it("sums flat MCP summaries in major units", () => {
    expect(sumHomeCurrency({ priceNone: 10, priceLow: 100, priceLowVAT: 12, priceHigh: 0.1, priceHighVAT: 0.02, roundingAmount: -0.12 })).toBe(122);
    expect(sumHomeCurrency({})).toBeUndefined();
    expect(sumHomeCurrency({ priceHighSum: 121 })).toBe(121);
  });

  it("sums parsed POHODA export summaries with nested round and attribute-wrapped values", () => {
    const exported = {
      priceNone: "0",
      priceLow: "100",
      priceLowVAT: { "#text": "12", "@rate": "12" },
      priceLowSum: "112",
      priceHigh: "1000",
      priceHighVAT: { "#text": "210", "@rate": "21" },
      priceHighSum: "1210",
      price3: "0",
      price3VAT: "0",
      price3Sum: "0",
      round: { priceRound: "-0.4" }
    };
    expect(sumHomeCurrency(exported)).toBe(1321.6);
    expect(sumHomeCurrencyMinor({ round: { priceRound: "0.5" } })).toBe(50);
  });

  it("counts flat and nested rounding once and rejects conflicts", () => {
    expect(sumHomeCurrency({ priceNone: 100, roundingAmount: -0.4, round: { priceRound: "-0.4" } })).toBe(99.6);
    expect(() => sumHomeCurrency({ priceNone: 100, roundingAmount: -0.4, round: { priceRound: "0.4" } })).toThrow(/differs/);
  });

  it("reports bucket Sum discrepancies without changing the sum basis", () => {
    const home = { priceHigh: 100, priceHighVAT: 21, priceHighSum: 122 };
    expect(sumHomeCurrency(home)).toBe(121);
    expect(homeCurrencyDiscrepancies(home)).toEqual(["priceHigh + priceHighVAT = 121.00 but priceHighSum = 122.00."]);
  });
});
