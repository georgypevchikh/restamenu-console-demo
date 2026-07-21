/**
 * Versioned tax calculation engine.
 *
 * Interprets the rule-set documents stored in tax_rule_sets (migration 017):
 * category-scoped VAT with a default rate, an optional withholding rule above
 * a threshold, and a configurable rounding mode. Produces a full trace —
 * every input, every matched rule, every intermediate value — which is
 * persisted immutably in tax_calculations next to the document it priced.
 *
 * Rounding is per line (tax is rounded on each line, then summed), the most
 * common invoicing convention; the trace records it so the choice is visible.
 * Withholding applies to the pre-tax subtotal once it reaches the threshold.
 *
 * Pure and runtime-agnostic: tested by Vitest (Node) and `deno test`.
 */

import {
  addSafeIntegers,
  applyRateBps,
  lineSubtotalMinor,
  MoneyError,
  parseQuantityToMilli,
  type RoundingMode,
} from "./money.ts";

export interface VatRule {
  kind: "vat";
  name: string;
  rate_bps: number;
  applies_to: "default" | "categories";
  categories?: string[];
}

export interface WithholdingRule {
  kind: "withholding";
  name: string;
  rate_bps: number;
  threshold_minor: number;
}

export type TaxRule = VatRule | WithholdingRule;

export interface RuleSet {
  id: string;
  version: number;
  name: string;
  effective_from: string; // YYYY-MM-DD
  effective_to: string | null;
  rounding_mode: RoundingMode;
  rules: TaxRule[];
}

export interface LineInput {
  description: string;
  category_name?: string | null;
  quantity: string | number;
  unit?: string | null;
  unit_price_minor: number;
  product_id?: string | null;
  request_id?: string | null;
}

export interface CalculatedLine {
  description: string;
  category_name: string | null;
  quantity_milli: number;
  unit: string | null;
  unit_price_minor: number;
  line_subtotal_minor: number;
  tax_minor: number;
  line_total_minor: number;
  product_id: string | null;
  request_id: string | null;
  tax_detail: {
    rule_name: string;
    rate_bps: number;
  };
}

export interface TraceStep {
  step: string;
  detail: Record<string, unknown>;
}

export interface CalcResult {
  lines: CalculatedLine[];
  subtotal_minor: number;
  tax_total_minor: number;
  withholding_minor: number;
  total_minor: number;
  rule_set: {
    id: string;
    version: number;
    name: string;
    rounding_mode: RoundingMode;
  };
  trace: TraceStep[];
}

export class TaxEngineError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "TaxEngineError";
  }
}

const MAX_LINES = 250;
const MAX_TEXT_LENGTH = 300;
const MAX_RATE_BPS = 10_000;

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function requireText(
  value: unknown,
  field: string,
  max = MAX_TEXT_LENGTH,
  code = "bad_input",
): string {
  if (
    typeof value !== "string" || value.trim().length === 0 || value.length > max
  ) {
    throw new TaxEngineError(
      code,
      `${field} must be 1-${max} characters`,
    );
  }
  return value;
}

/** Validate a database JSON rule document before financial arithmetic uses it. */
export function validateRuleSet(ruleSet: RuleSet): void {
  if (!Number.isSafeInteger(ruleSet.version) || ruleSet.version <= 0) {
    throw new TaxEngineError(
      "invalid_rule_set",
      "rule set version must be a positive integer",
    );
  }
  requireText(
    ruleSet.name,
    "rule set name",
    MAX_TEXT_LENGTH,
    "invalid_rule_set",
  );
  if (
    !isIsoDate(ruleSet.effective_from) ||
    (ruleSet.effective_to !== null && !isIsoDate(ruleSet.effective_to))
  ) {
    throw new TaxEngineError(
      "invalid_rule_set",
      "rule set effective dates must be real YYYY-MM-DD dates",
    );
  }
  if (
    ruleSet.effective_to !== null &&
    ruleSet.effective_to < ruleSet.effective_from
  ) {
    throw new TaxEngineError(
      "invalid_rule_set",
      "effective_to cannot precede effective_from",
    );
  }
  if (
    ruleSet.rounding_mode !== "half_up" && ruleSet.rounding_mode !== "bankers"
  ) {
    throw new TaxEngineError("invalid_rule_set", "unsupported rounding mode");
  }
  if (!Array.isArray(ruleSet.rules)) {
    throw new TaxEngineError("invalid_rule_set", "rules must be an array");
  }
  if (ruleSet.rules.length > 100) {
    throw new TaxEngineError(
      "invalid_rule_set",
      "a rule set may contain at most 100 rules",
    );
  }

  let defaultVatRules = 0;
  let withholdingRules = 0;
  const assignedCategories = new Set<string>();
  for (const [index, rule] of ruleSet.rules.entries()) {
    if (!rule || typeof rule !== "object") {
      throw new TaxEngineError(
        "invalid_rule_set",
        `rule ${index + 1} must be an object`,
      );
    }
    requireText(
      rule.name,
      `rule ${index + 1} name`,
      MAX_TEXT_LENGTH,
      "invalid_rule_set",
    );
    if (
      !Number.isSafeInteger(rule.rate_bps) || rule.rate_bps < 0 ||
      rule.rate_bps > MAX_RATE_BPS
    ) {
      throw new TaxEngineError(
        "invalid_rule_set",
        `rule ${
          index + 1
        } rate_bps must be an integer between 0 and ${MAX_RATE_BPS}`,
      );
    }

    if (rule.kind === "vat") {
      if (rule.applies_to !== "default" && rule.applies_to !== "categories") {
        throw new TaxEngineError(
          "invalid_rule_set",
          `rule ${index + 1} has an invalid applies_to`,
        );
      }
      if (rule.applies_to === "default") {
        defaultVatRules += 1;
      } else if (
        !Array.isArray(rule.categories) ||
        rule.categories.length === 0 ||
        rule.categories.some(
          (category) =>
            typeof category !== "string" ||
            category.trim().length === 0 ||
            category.length > MAX_TEXT_LENGTH,
        )
      ) {
        throw new TaxEngineError(
          "invalid_rule_set",
          `rule ${index + 1} needs valid categories`,
        );
      } else if (rule.applies_to === "categories") {
        for (const rawCategory of rule.categories ?? []) {
          const category = rawCategory.trim();
          if (assignedCategories.has(category)) {
            throw new TaxEngineError(
              "invalid_rule_set",
              `category ${category} is assigned to more than one VAT rule`,
            );
          }
          assignedCategories.add(category);
        }
      }
    } else if (rule.kind === "withholding") {
      withholdingRules += 1;
      if (
        !Number.isSafeInteger(rule.threshold_minor) || rule.threshold_minor < 0
      ) {
        throw new TaxEngineError(
          "invalid_rule_set",
          `rule ${index + 1} has an invalid threshold_minor`,
        );
      }
    } else {
      throw new TaxEngineError(
        "invalid_rule_set",
        `rule ${index + 1} has an unsupported kind`,
      );
    }
  }

  if (defaultVatRules > 1) {
    throw new TaxEngineError(
      "invalid_rule_set",
      "only one default VAT rule is allowed",
    );
  }
  if (withholdingRules > 1) {
    throw new TaxEngineError(
      "invalid_rule_set",
      "only one withholding rule is allowed",
    );
  }
}

/**
 * Pick the rule set effective on a date: among versions whose
 * [effective_from, effective_to] window contains the date, the highest
 * version wins. Historical documents keep the version that priced them.
 */
export function selectRuleSet(ruleSets: RuleSet[], onDate: string): RuleSet {
  if (!isIsoDate(onDate)) {
    throw new TaxEngineError("bad_date", `invalid calculation date: ${onDate}`);
  }
  // Filter the SQL date envelope before parsing its JSON rules. An invalid
  // future or historical document must not take current pricing offline.
  const candidates = ruleSets.filter((rs) => {
    if (rs.effective_from > onDate) return false;
    if (rs.effective_to !== null && rs.effective_to < onDate) return false;
    return true;
  });
  if (candidates.length === 0) {
    throw new TaxEngineError(
      "no_effective_rule_set",
      `no rule set effective on ${onDate} (have versions: ${
        ruleSets.map((r) => r.version).join(", ") || "none"
      })`,
    );
  }
  for (const ruleSet of candidates) validateRuleSet(ruleSet);
  return candidates.reduce((a, b) => (b.version > a.version ? b : a));
}

function matchVatRule(
  ruleSet: RuleSet,
  categoryName: string | null,
): VatRule | null {
  const vatRules = ruleSet.rules.filter((r): r is VatRule => r.kind === "vat");
  if (categoryName) {
    const scoped = vatRules.find(
      (r) =>
        r.applies_to === "categories" &&
        (r.categories ?? []).includes(categoryName),
    );
    if (scoped) return scoped;
  }
  return vatRules.find((r) => r.applies_to === "default") ?? null;
}

export function calculate(ruleSet: RuleSet, lines: LineInput[]): CalcResult {
  validateRuleSet(ruleSet);
  if (lines.length === 0) {
    throw new TaxEngineError("no_lines", "at least one line is required");
  }
  if (lines.length > MAX_LINES) {
    throw new TaxEngineError(
      "too_many_lines",
      `at most ${MAX_LINES} lines are allowed`,
    );
  }

  const mode = ruleSet.rounding_mode;
  const trace: TraceStep[] = [
    {
      step: "rule_set_selected",
      detail: {
        id: ruleSet.id,
        version: ruleSet.version,
        name: ruleSet.name,
        rounding_mode: mode,
        rounding_scope: "per_line",
      },
    },
  ];

  const calculated: CalculatedLine[] = [];
  let subtotal = 0;
  let taxTotal = 0;

  for (const [i, line] of lines.entries()) {
    requireText(line.description, `line ${i + 1} description`);
    if (
      line.category_name !== undefined &&
      line.category_name !== null &&
      line.category_name.length > MAX_TEXT_LENGTH
    ) {
      throw new TaxEngineError(
        "bad_input",
        `line ${i + 1} category is too long`,
      );
    }
    if (
      line.unit !== undefined && line.unit !== null && line.unit.length > 50
    ) {
      throw new TaxEngineError("bad_input", `line ${i + 1} unit is too long`);
    }

    let quantityMilli: number;
    let lineSubtotal: number;
    try {
      quantityMilli = parseQuantityToMilli(line.quantity);
      lineSubtotal = lineSubtotalMinor(
        quantityMilli,
        line.unit_price_minor,
        mode,
      );
    } catch (err) {
      if (err instanceof MoneyError) {
        throw new TaxEngineError(
          err.code,
          `line ${i + 1} (${line.description}): ${err.message}`,
        );
      }
      throw err;
    }

    const category = line.category_name ?? null;
    const rule = matchVatRule(ruleSet, category);
    const taxMinor = rule ? applyRateBps(lineSubtotal, rule.rate_bps, mode) : 0;

    trace.push({
      step: "line_priced",
      detail: {
        line: i + 1,
        description: line.description,
        category,
        quantity_milli: quantityMilli,
        unit_price_minor: line.unit_price_minor,
        line_subtotal_minor: lineSubtotal,
        matched_rule: rule
          ? {
            name: rule.name,
            rate_bps: rule.rate_bps,
            applies_to: rule.applies_to,
          }
          : null,
        tax_minor: taxMinor,
      },
    });

    const lineTotal = addSafeIntegers(lineSubtotal, taxMinor);
    calculated.push({
      description: line.description,
      category_name: category,
      quantity_milli: quantityMilli,
      unit: line.unit ?? null,
      unit_price_minor: line.unit_price_minor,
      line_subtotal_minor: lineSubtotal,
      tax_minor: taxMinor,
      line_total_minor: lineTotal,
      product_id: line.product_id ?? null,
      request_id: line.request_id ?? null,
      tax_detail: {
        rule_name: rule?.name ?? "No VAT rule",
        rate_bps: rule?.rate_bps ?? 0,
      },
    });

    subtotal = addSafeIntegers(subtotal, lineSubtotal);
    taxTotal = addSafeIntegers(taxTotal, taxMinor);
  }

  const withholdingRule = ruleSet.rules.find(
    (r): r is WithholdingRule => r.kind === "withholding",
  );
  let withholding = 0;
  if (withholdingRule && subtotal >= withholdingRule.threshold_minor) {
    withholding = applyRateBps(subtotal, withholdingRule.rate_bps, mode);
    trace.push({
      step: "withholding_applied",
      detail: {
        rule: withholdingRule.name,
        rate_bps: withholdingRule.rate_bps,
        threshold_minor: withholdingRule.threshold_minor,
        base_minor: subtotal,
        withholding_minor: withholding,
      },
    });
  } else if (withholdingRule) {
    trace.push({
      step: "withholding_below_threshold",
      detail: {
        rule: withholdingRule.name,
        threshold_minor: withholdingRule.threshold_minor,
        base_minor: subtotal,
      },
    });
  }

  const gross = addSafeIntegers(subtotal, taxTotal);
  const total = addSafeIntegers(gross, -withholding);

  trace.push({
    step: "totals",
    detail: {
      subtotal_minor: subtotal,
      tax_total_minor: taxTotal,
      withholding_minor: withholding,
      total_minor: total,
    },
  });

  return {
    lines: calculated,
    subtotal_minor: subtotal,
    tax_total_minor: taxTotal,
    withholding_minor: withholding,
    total_minor: total,
    rule_set: {
      id: ruleSet.id,
      version: ruleSet.version,
      name: ruleSet.name,
      rounding_mode: mode,
    },
    trace,
  };
}
