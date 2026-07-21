import { describe, expect, it } from "vitest";
import {
  majorPriceToMinor,
  parseOrderLines,
  validateSupplierName,
} from "../lib/order-input";

const UUID = "11111111-2000-4000-8000-000000000001";

function line(overrides: Record<string, unknown> = {}) {
  return {
    request_id: UUID,
    product_id: UUID,
    description: " Tomatoes ",
    category_name: " Produce ",
    quantity: "1.250",
    unit: " kg ",
    unit_price_minor: 250,
    ...overrides,
  };
}

describe("order server-action input", () => {
  it("normalizes a valid bounded line", () => {
    expect(parseOrderLines(JSON.stringify([line()]))).toEqual([
      expect.objectContaining({
        description: "Tomatoes",
        category_name: "Produce",
        unit: "kg",
        quantity: "1.250",
        unit_price_minor: 250,
      }),
    ]);
    expect(validateSupplierName(" Fresh Farms ")).toBe("Fresh Farms");
  });

  it.each([
    ["malformed JSON", "{"],
    ["empty lines", "[]"],
    ["negative price", JSON.stringify([line({ unit_price_minor: -1 })])],
    [
      "fractional minor price",
      JSON.stringify([line({ unit_price_minor: 1.5 })]),
    ],
    ["bad UUID", JSON.stringify([line({ product_id: "not-a-uuid" })])],
    ["zero quantity", JSON.stringify([line({ quantity: "0" })])],
    ["too precise quantity", JSON.stringify([line({ quantity: "1.0001" })])],
    [
      "oversized description",
      JSON.stringify([line({ description: "x".repeat(301) })]),
    ],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseOrderLines(raw)).toThrow();
  });

  it("caps line count and raw payload size", () => {
    expect(() =>
      parseOrderLines(
        JSON.stringify(Array.from({ length: 251 }, () => line())),
      ),
    ).toThrow("at most 250");
    expect(() => parseOrderLines(" ".repeat(256_001))).toThrow("too large");
  });

  it("caps supplier names", () => {
    expect(() => validateSupplierName(" ")).toThrow("1-200");
    expect(() => validateSupplierName("x".repeat(201))).toThrow("1-200");
  });

  it("converts decimal prices without floating-point rounding", () => {
    expect(majorPriceToMinor("0.29")).toBe(29);
    expect(majorPriceToMinor("12.3")).toBe(1230);
    expect(() => majorPriceToMinor("1.001")).toThrow("at most 2");
    expect(() => majorPriceToMinor("1e3")).toThrow("at most 2");
    expect(() => majorPriceToMinor("999999999999999999999")).toThrow(
      "out of range",
    );
  });
});
