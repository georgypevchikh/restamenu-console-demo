/**
 * Tax engine unit tests — pure logic, no network, no database.
 * The same modules are exercised under Deno in
 * supabase/functions/tests/core_test.ts; this suite is the Node side.
 */

import { describe, expect, it } from "vitest";
import {
  calculate,
  type RuleSet,
  selectRuleSet,
  TaxEngineError,
  validateRuleSet,
} from "../supabase/functions/_shared/core/tax-engine.ts";
import {
  applyRateBps,
  lineSubtotalMinor,
  minorToMajorString,
  MoneyError,
  parseQuantityToMilli,
  roundDiv,
} from "../supabase/functions/_shared/core/money.ts";

const RULE_SET_V1: RuleSet = {
  id: "rs-v1",
  version: 1,
  name: "EU VAT 2026 H1",
  effective_from: "2026-01-01",
  effective_to: "2026-06-30",
  rounding_mode: "half_up",
  rules: [
    {
      kind: "vat",
      name: "Standard VAT",
      rate_bps: 2100,
      applies_to: "default",
    },
    {
      kind: "vat",
      name: "Reduced VAT",
      rate_bps: 900,
      applies_to: "categories",
      categories: ["Produce", "Dairy"],
    },
    {
      kind: "withholding",
      name: "Vendor withholding",
      rate_bps: 200,
      threshold_minor: 100_000,
    },
  ],
};

const RULE_SET_V2: RuleSet = {
  ...RULE_SET_V1,
  id: "rs-v2",
  version: 2,
  name: "EU VAT 2026 H2",
  effective_from: "2026-07-01",
  effective_to: null,
  rules: [
    {
      kind: "vat",
      name: "Standard VAT",
      rate_bps: 2200,
      applies_to: "default",
    },
    {
      kind: "vat",
      name: "Reduced VAT",
      rate_bps: 900,
      applies_to: "categories",
      categories: ["Produce", "Dairy"],
    },
    {
      kind: "withholding",
      name: "Vendor withholding",
      rate_bps: 200,
      threshold_minor: 100_000,
    },
  ],
};

describe("money primitives", () => {
  it("applies bps rates with half-up rounding", () => {
    // 1000 * 21% = 210 exactly
    expect(applyRateBps(1000, 2100, "half_up")).toBe(210);
    // 105 * 21% = 22.05 → 22
    expect(applyRateBps(105, 2100, "half_up")).toBe(22);
    // 50 * 21% = 10.5 → 11 (half up)
    expect(applyRateBps(50, 2100, "half_up")).toBe(11);
  });

  it("banker's rounding sends exact halves to even", () => {
    // 50 * 21% = 10.5 → 10 (nearest even)
    expect(applyRateBps(50, 2100, "bankers")).toBe(10);
    // 150 * 21% = 31.5 → 32 (nearest even)
    expect(applyRateBps(150, 2100, "bankers")).toBe(32);
    // Non-halves are unaffected
    expect(applyRateBps(105, 2100, "bankers")).toBe(22);
  });

  it("roundDiv rejects negatives and unsafe integers", () => {
    expect(() => roundDiv(-1, 10, "half_up")).toThrow(MoneyError);
    expect(() => roundDiv(Number.MAX_SAFE_INTEGER + 1, 10, "half_up")).toThrow(
      MoneyError,
    );
  });

  it("parses quantities into milli-units strictly", () => {
    expect(parseQuantityToMilli("2")).toBe(2000);
    expect(parseQuantityToMilli("2.5")).toBe(2500);
    expect(parseQuantityToMilli("12.345")).toBe(12345);
    expect(parseQuantityToMilli(3)).toBe(3000);
    expect(() => parseQuantityToMilli("0")).toThrow(MoneyError);
    expect(() => parseQuantityToMilli("-1")).toThrow(MoneyError);
    expect(() => parseQuantityToMilli("1.2345")).toThrow(MoneyError);
    expect(() => parseQuantityToMilli("abc")).toThrow(MoneyError);
    expect(() => parseQuantityToMilli("1e3")).toThrow(MoneyError);
  });

  it("computes line subtotals from milli-quantities without floats", () => {
    // 2.5 kg × 3.99 → 9.975 → 998 (half-up)
    expect(lineSubtotalMinor(2500, 399, "half_up")).toBe(998);
    // and to even under banker's: 9.975 is NOT an exact half of a cent — both modes agree
    expect(lineSubtotalMinor(2500, 399, "bankers")).toBe(998);
    // exact half-cent: 0.5 × 0.01 = 0.005 → 1 (half_up) / 0 (bankers)
    expect(lineSubtotalMinor(500, 1, "half_up")).toBe(1);
    expect(lineSubtotalMinor(500, 1, "bankers")).toBe(0);
  });

  it("formats minor units for display", () => {
    expect(minorToMajorString(12345)).toBe("123.45");
    expect(minorToMajorString(5)).toBe("0.05");
    expect(minorToMajorString(0)).toBe("0.00");
  });
});

describe("rule set selection", () => {
  const sets = [RULE_SET_V1, RULE_SET_V2];

  it("selects by effective date", () => {
    expect(selectRuleSet(sets, "2026-03-15").version).toBe(1);
    expect(selectRuleSet(sets, "2026-07-01").version).toBe(2);
    expect(selectRuleSet(sets, "2026-12-31").version).toBe(2);
  });

  it("boundary days belong to the window edges", () => {
    expect(selectRuleSet(sets, "2026-01-01").version).toBe(1);
    expect(selectRuleSet(sets, "2026-06-30").version).toBe(1);
  });

  it("throws when nothing is effective", () => {
    expect(() => selectRuleSet(sets, "2025-12-31")).toThrow(TaxEngineError);
    expect(() => selectRuleSet([], "2026-01-01")).toThrow(TaxEngineError);
  });

  it("rejects impossible calendar dates", () => {
    expect(() => selectRuleSet(sets, "2026-02-31")).toThrowError(
      expect.objectContaining({ code: "bad_date" }),
    );
  });

  it("highest version wins on overlap", () => {
    const overlapping: RuleSet = {
      ...RULE_SET_V2,
      effective_from: "2026-06-01",
    };
    expect(selectRuleSet([RULE_SET_V1, overlapping], "2026-06-15").version)
      .toBe(2);
  });

  it("ignores malformed non-effective JSON when selecting today's valid version", () => {
    const malformedFuture: RuleSet = {
      ...RULE_SET_V2,
      version: 3,
      effective_from: "2027-01-01",
      rules: [null] as unknown as RuleSet["rules"],
    };
    expect(selectRuleSet([RULE_SET_V2, malformedFuture], "2026-07-21").version)
      .toBe(2);
  });
});

describe("rule document validation", () => {
  it("rejects ambiguous default VAT rules", () => {
    const invalid: RuleSet = {
      ...RULE_SET_V2,
      rules: [
        ...RULE_SET_V2.rules,
        {
          kind: "vat",
          name: "Second default",
          rate_bps: 500,
          applies_to: "default",
        },
      ],
    };
    expect(() => validateRuleSet(invalid)).toThrowError(
      expect.objectContaining({ code: "invalid_rule_set" }),
    );
  });

  it("rejects duplicate category assignments whose tax would depend on JSON order", () => {
    const invalid: RuleSet = {
      ...RULE_SET_V2,
      rules: [
        {
          kind: "vat",
          name: "Reduced A",
          rate_bps: 500,
          applies_to: "categories",
          categories: ["Produce"],
        },
        {
          kind: "vat",
          name: "Reduced B",
          rate_bps: 900,
          applies_to: "categories",
          categories: ["Produce"],
        },
      ],
    };
    expect(() => validateRuleSet(invalid)).toThrowError(
      expect.objectContaining({ code: "invalid_rule_set" }),
    );
  });

  it("rejects negative and over-100-percent rates", () => {
    for (const rate_bps of [-1, 10_001]) {
      const invalid: RuleSet = {
        ...RULE_SET_V2,
        rules: [{ kind: "vat", name: "Bad", rate_bps, applies_to: "default" }],
      };
      expect(() => validateRuleSet(invalid)).toThrowError(
        expect.objectContaining({ code: "invalid_rule_set" }),
      );
    }
  });
});

describe("calculate", () => {
  it("prices a mixed-category order with per-line rounding", () => {
    const result = calculate(RULE_SET_V1, [
      // Dry goods → standard 21%: 20 kg × 1.20 = 24.00 → tax 5.04
      {
        description: "Flour 00",
        category_name: "Dry goods",
        quantity: "20",
        unit: "kg",
        unit_price_minor: 120,
      },
      // Produce → reduced 9%: 5 kg × 2.50 = 12.50 → tax 1.125 → 1.13 (half-up)
      {
        description: "Tomatoes",
        category_name: "Produce",
        quantity: "5",
        unit: "kg",
        unit_price_minor: 250,
      },
    ]);

    expect(result.lines[0].tax_detail.rule_name).toBe("Standard VAT");
    expect(result.lines[0].line_subtotal_minor).toBe(2400);
    expect(result.lines[0].tax_minor).toBe(504);

    expect(result.lines[1].tax_detail.rule_name).toBe("Reduced VAT");
    expect(result.lines[1].line_subtotal_minor).toBe(1250);
    expect(result.lines[1].tax_minor).toBe(113);

    expect(result.subtotal_minor).toBe(3650);
    expect(result.tax_total_minor).toBe(617);
    expect(result.withholding_minor).toBe(0); // below 1000.00 threshold
    expect(result.total_minor).toBe(3650 + 617);
  });

  it("applies withholding at the threshold", () => {
    const result = calculate(RULE_SET_V1, [
      // 1000.00 subtotal — exactly at threshold_minor 100000
      {
        description: "Bulk order",
        category_name: null,
        quantity: "1",
        unit_price_minor: 100_000,
      },
    ]);
    expect(result.withholding_minor).toBe(2000); // 2% of 1000.00
    expect(result.total_minor).toBe(100_000 + 21_000 - 2000);
    expect(result.trace.some((t) => t.step === "withholding_applied")).toBe(
      true,
    );
  });

  it("records withholding_below_threshold in the trace", () => {
    const result = calculate(RULE_SET_V1, [
      { description: "Small order", quantity: "1", unit_price_minor: 500 },
    ]);
    expect(result.withholding_minor).toBe(0);
    expect(result.trace.some((t) => t.step === "withholding_below_threshold"))
      .toBe(true);
  });

  it("uncategorised lines fall back to the default rate", () => {
    const result = calculate(RULE_SET_V1, [
      {
        description: "Misc",
        category_name: "Unknown category",
        quantity: "1",
        unit_price_minor: 1000,
      },
    ]);
    expect(result.lines[0].tax_detail.rule_name).toBe("Standard VAT");
  });

  it("rejects blank descriptions and excessive line counts", () => {
    const line = { description: "Item", quantity: "1", unit_price_minor: 100 };
    expect(() => calculate(RULE_SET_V2, [{ ...line, description: "   " }]))
      .toThrowError(
        expect.objectContaining({ code: "bad_input" }),
      );
    expect(() =>
      calculate(RULE_SET_V2, Array.from({ length: 251 }, () => line))
    ).toThrowError(
      expect.objectContaining({ code: "too_many_lines" }),
    );
  });

  it("rejects arithmetic that would exceed safe integer precision", () => {
    expect(() =>
      calculate(RULE_SET_V2, [
        {
          description: "Unsafe",
          quantity: "999999999999.999",
          unit_price_minor: 999999999999,
        },
      ])
    ).toThrowError(expect.objectContaining({ code: "unsafe_integer" }));
  });

  it("v2 rate change is visible for the same input", () => {
    const lines = [{
      description: "Flour",
      category_name: "Dry goods",
      quantity: "10",
      unit_price_minor: 100,
    }];
    expect(calculate(RULE_SET_V1, lines).tax_total_minor).toBe(210); // 21%
    expect(calculate(RULE_SET_V2, lines).tax_total_minor).toBe(220); // 22%
  });

  it("produces a complete trace", () => {
    const result = calculate(RULE_SET_V1, [
      {
        description: "Basil",
        category_name: "Produce",
        quantity: "3",
        unit_price_minor: 150,
      },
    ]);
    const steps = result.trace.map((t) => t.step);
    expect(steps[0]).toBe("rule_set_selected");
    expect(steps).toContain("line_priced");
    expect(steps.at(-1)).toBe("totals");
    // Line totals in the result always reconcile
    for (const line of result.lines) {
      expect(line.line_subtotal_minor + line.tax_minor).toBe(
        line.line_total_minor,
      );
    }
  });

  it("rejects empty and invalid input with typed errors", () => {
    expect(() => calculate(RULE_SET_V1, [])).toThrow(TaxEngineError);
    expect(() =>
      calculate(RULE_SET_V1, [{
        description: "Bad",
        quantity: "-2",
        unit_price_minor: 100,
      }])
    ).toThrow(TaxEngineError);
    expect(() =>
      calculate(RULE_SET_V1, [{
        description: "Bad",
        quantity: "1",
        unit_price_minor: 10.5,
      }])
    ).toThrow(TaxEngineError);
  });

  it("handles a no-VAT rule set (zero tax, coherent totals)", () => {
    const noVat: RuleSet = { ...RULE_SET_V1, rules: [] };
    const result = calculate(noVat, [{
      description: "X",
      quantity: "2",
      unit_price_minor: 100,
    }]);
    expect(result.tax_total_minor).toBe(0);
    expect(result.total_minor).toBe(200);
    expect(result.lines[0].tax_detail.rule_name).toBe("No VAT rule");
  });
});
