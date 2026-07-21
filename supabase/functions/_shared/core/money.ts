/**
 * Integer money math. Amounts are minor units (cents), rates are basis
 * points, quantities are milli-units (thousandths). Everything stays in
 * integer arithmetic — no floats ever touch an amount — so results are
 * identical across Node, Deno, and Postgres reimplementations.
 *
 * Runtime-agnostic on purpose: this file is unit-tested by Vitest (Node) and
 * `deno test`, and bundles into Edge Functions unchanged.
 */

export type RoundingMode = "half_up" | "bankers";

export class MoneyError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Add integer amounts without silently crossing JavaScript's safe range. */
export function addSafeIntegers(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError(
        "unsafe_integer",
        `invalid integer amount: ${value}`,
      );
    }
    const next = total + value;
    if (!Number.isSafeInteger(next)) {
      throw new MoneyError(
        "unsafe_integer",
        `integer sum exceeds safe range: ${total} + ${value}`,
      );
    }
    total = next;
  }
  return total;
}

/** Integer division with explicit rounding of the exact remainder. */
export function roundDiv(
  numerator: number,
  denominator: number,
  mode: RoundingMode,
): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new MoneyError(
      "unsafe_integer",
      `roundDiv(${numerator}, ${denominator}) exceeds safe integers`,
    );
  }
  if (denominator <= 0) {
    throw new MoneyError(
      "bad_denominator",
      `denominator must be positive, got ${denominator}`,
    );
  }
  if (numerator < 0) {
    throw new MoneyError(
      "negative_amount",
      `negative amounts are not supported, got ${numerator}`,
    );
  }

  const q = Math.trunc(numerator / denominator);
  const r = numerator - q * denominator;
  if (r === 0) return q;

  const doubled = r * 2;
  if (doubled > denominator) return q + 1;
  if (doubled < denominator) return q;

  // Exactly half.
  if (mode === "half_up") return q + 1;
  return q % 2 === 0 ? q : q + 1; // banker's: round half to even
}

/** amountMinor × rateBps → minor units, rounded per mode. */
export function applyRateBps(
  amountMinor: number,
  rateBps: number,
  mode: RoundingMode,
): number {
  if (!Number.isSafeInteger(rateBps) || rateBps < 0) {
    throw new MoneyError(
      "bad_rate",
      `rate must be a non-negative integer, got ${rateBps}`,
    );
  }
  return roundDiv(amountMinor * rateBps, 10_000, mode);
}

/**
 * Parse a quantity ("2", "2.5", "12.345", 3) into integer milli-units.
 * Rejects negatives, zero, more than 3 decimals, and non-numeric input —
 * quantities come from a form and are the engine's only fractional input.
 */
export function parseQuantityToMilli(quantity: string | number): number {
  const s = String(quantity).trim();
  if (!/^\d+(\.\d{1,3})?$/.test(s)) {
    throw new MoneyError(
      "bad_quantity",
      `invalid quantity: ${JSON.stringify(quantity)}`,
    );
  }
  const [whole, frac = ""] = s.split(".");
  const milli = Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
  if (!Number.isSafeInteger(milli) || milli <= 0) {
    throw new MoneyError("bad_quantity", `quantity out of range: ${s}`);
  }
  return milli;
}

/** quantity (milli) × unit price (minor) → line subtotal in minor units. */
export function lineSubtotalMinor(
  quantityMilli: number,
  unitPriceMinor: number,
  mode: RoundingMode,
): number {
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli <= 0) {
    throw new MoneyError(
      "bad_quantity",
      `invalid milli-unit quantity: ${quantityMilli}`,
    );
  }
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) {
    throw new MoneyError(
      "bad_unit_price",
      `invalid unit price: ${unitPriceMinor}`,
    );
  }
  return roundDiv(quantityMilli * unitPriceMinor, 1000, mode);
}

/** 12345 → "123.45" — only for display and external APIs (Xero, PDF). */
export function minorToMajorString(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100);
  const cents = abs - whole * 100;
  return `${sign}${whole}.${String(cents).padStart(2, "0")}`;
}
