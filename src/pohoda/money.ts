/**
 * Exact money helpers for accounting amounts with at most two decimal places.
 *
 * Amounts are converted to integer minor units (haléř/cent) so equality checks never
 * depend on binary floating point. Numeric inputs such as `0.1 + 0.2` are accepted when
 * they are within a tiny representation epsilon of a 2-decimal value; genuine values with
 * more precision (for example `10.005`) are rejected instead of being rounded.
 */

/**
 * Tolerance for binary representation noise after multiplying by 100. It is based on
 * machine precision relative to the magnitude (a few ULPs) plus a tiny absolute floor,
 * and hard-capped far below half a minor unit so values like 10000.005 are rejected.
 */
const ABSOLUTE_FLOOR = 1e-9;
const ABSOLUTE_CAP = 1e-4;
const ULP_FACTOR = 16;

function representationTolerance(scaled: number): number {
  return Math.min(ABSOLUTE_CAP, Math.abs(scaled) * Number.EPSILON * ULP_FACTOR + ABSOLUTE_FLOOR);
}

export class MoneyError extends Error {
  public readonly label: string;

  public constructor(message: string, label: string) {
    super(message);
    this.name = "MoneyError";
    this.label = label;
  }
}

export function isMoneyInput(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  return typeof value === "number";
}

export function toMinorUnits(value: number | string, label = "amount"): number {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string") {
    const text = value.trim().replace(",", ".");
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) {
      throw new MoneyError(`${label} must be a decimal number, got "${value}".`, label);
    }
    const fraction = text.split(".")[1] ?? "";
    if (fraction.replace(/0+$/, "").length > 2) {
      throw new MoneyError(`${label} has more than two decimal places: ${value}.`, label);
    }
    numeric = Number(text);
  } else {
    throw new MoneyError(`${label} must be a number.`, label);
  }
  if (!Number.isFinite(numeric)) {
    throw new MoneyError(`${label} must be a finite number.`, label);
  }
  const scaled = numeric * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > representationTolerance(scaled)) {
    throw new MoneyError(`${label} has more than two decimal places: ${value}.`, label);
  }
  if (!Number.isSafeInteger(rounded)) {
    throw new MoneyError(`${label} is too large.`, label);
  }
  return rounded === 0 ? 0 : rounded;
}

export function fromMinorUnits(minor: number): number {
  return Number((minor / 100).toFixed(2));
}

export function formatMinorUnits(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  const whole = Math.trunc(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${sign}${whole}.${fraction}`;
}

export function formatMoney(value: number | string, label = "amount"): string {
  return formatMinorUnits(toMinorUnits(value, label));
}

/** Normalized number for XML output: exact 2dp value without float noise. */
export function roundMoney(value: number | string, label = "amount"): number {
  return fromMinorUnits(toMinorUnits(value, label));
}

export const homeSummaryFields = [
  "priceNone",
  "priceLow", "priceLowVAT", "priceLowSum",
  "priceHigh", "priceHighVAT", "priceHighSum",
  "price3", "price3VAT", "price3Sum"
] as const;

export type VatBucket = {
  name: "low" | "high" | "third";
  base: string;
  vat: string;
  sum: string;
};

export const vatBuckets: VatBucket[] = [
  { name: "low", base: "priceLow", vat: "priceLowVAT", sum: "priceLowSum" },
  { name: "high", base: "priceHigh", vat: "priceHighVAT", sum: "priceHighSum" },
  { name: "third", base: "price3", vat: "price3VAT", sum: "price3Sum" }
];

/** Unwraps parsed XML scalars such as `{ "#text": "21", "@rate": "21" }`. */
export function moneyValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "#text" in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>)["#text"];
  }
  return value;
}

function presentMoney(home: Record<string, any>, key: string): boolean {
  return isMoneyInput(moneyValue(home[key]));
}

function minorOf(home: Record<string, any>, key: string, label = key): number {
  return toMinorUnits(moneyValue(home[key]) as number | string, label);
}

/**
 * Rounding contained in a summary: flat `roundingAmount` (MCP input) or nested
 * `round.priceRound` (POHODA export/XML shape). When both exist they must agree and
 * are counted once.
 */
export function roundingMinor(home: Record<string, any>): number | undefined {
  const flat = presentMoney(home, "roundingAmount") ? minorOf(home, "roundingAmount") : undefined;
  const round = home.round && typeof home.round === "object" ? home.round as Record<string, any> : undefined;
  const nested = round && presentMoney(round, "priceRound") ? minorOf(round, "priceRound", "round.priceRound") : undefined;
  if (flat !== undefined && nested !== undefined && flat !== nested) {
    throw new MoneyError(`roundingAmount ${formatMinorUnits(flat)} differs from round.priceRound ${formatMinorUnits(nested)}.`, "roundingAmount");
  }
  return flat ?? nested;
}

/**
 * Sum of a POHODA home-currency summary in minor units: priceNone + every bucket gross
 * (base + VAT, or the explicit Sum when neither base nor VAT is given) + rounding
 * (flat roundingAmount or nested round.priceRound, counted once). Accepts both MCP input
 * and parsed POHODA export objects. Returns undefined when no amount field is present.
 */
export function sumHomeCurrencyMinor(home: Record<string, any>): number | undefined {
  let present = false;
  let total = 0;
  if (presentMoney(home, "priceNone")) {
    present = true;
    total += minorOf(home, "priceNone");
  }
  for (const bucket of vatBuckets) {
    const hasBase = presentMoney(home, bucket.base);
    const hasVat = presentMoney(home, bucket.vat);
    const hasSum = presentMoney(home, bucket.sum);
    if (!hasBase && !hasVat && !hasSum) {
      continue;
    }
    present = true;
    if (hasBase || hasVat) {
      total += (hasBase ? minorOf(home, bucket.base) : 0) + (hasVat ? minorOf(home, bucket.vat) : 0);
    } else {
      total += minorOf(home, bucket.sum);
    }
  }
  const rounding = roundingMinor(home);
  if (!present && rounding === undefined) {
    return undefined;
  }
  return total + (rounding ?? 0);
}

/** Major-unit (CZK) variant of sumHomeCurrencyMinor. */
export function sumHomeCurrency(home: Record<string, any>): number | undefined {
  const minor = sumHomeCurrencyMinor(home);
  return minor === undefined ? undefined : fromMinorUnits(minor);
}

/** Buckets whose explicit Sum disagrees with base + VAT (useful as verification warnings). */
export function homeCurrencyDiscrepancies(home: Record<string, any>): string[] {
  const warnings: string[] = [];
  for (const bucket of vatBuckets) {
    if (!presentMoney(home, bucket.sum) || (!presentMoney(home, bucket.base) && !presentMoney(home, bucket.vat))) {
      continue;
    }
    const gross = (presentMoney(home, bucket.base) ? minorOf(home, bucket.base) : 0) + (presentMoney(home, bucket.vat) ? minorOf(home, bucket.vat) : 0);
    const sum = minorOf(home, bucket.sum);
    if (gross !== sum) {
      warnings.push(`${bucket.base} + ${bucket.vat} = ${formatMinorUnits(gross)} but ${bucket.sum} = ${formatMinorUnits(sum)}.`);
    }
  }
  return warnings;
}
