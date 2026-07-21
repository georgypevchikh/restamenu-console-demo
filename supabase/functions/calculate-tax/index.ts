/**
 * POST { lines: LineInput[], on_date? } → CalcResult
 *
 * Prices a document with the caller's rule set effective on the date
 * (default: today). Reads go through the caller's own JWT — RLS decides which
 * rule sets are visible — and the pure engine does the math. Persisting the
 * result is the caller's job (create_purchase_order RPC stores result +
 * trace transactionally with the document).
 */

import { resolveCaller, userClient } from "../_shared/db.ts";
import { errorJson, internalError, json } from "../_shared/http.ts";
import {
  calculate,
  type LineInput,
  type RuleSet,
  selectRuleSet,
  TaxEngineError,
} from "../_shared/core/tax-engine.ts";
import { MoneyError } from "../_shared/core/money.ts";

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return errorJson(405, "method_not_allowed");

    const caller = await resolveCaller(req);
    if (!caller) return errorJson(401, "not_authenticated");
    if (caller.role !== "manager") return errorJson(403, "manager_required");

    const body = await req.json().catch(() => null) as {
      lines?: LineInput[];
      on_date?: string;
    } | null;
    if (!body?.lines || !Array.isArray(body.lines) || body.lines.length === 0) {
      return errorJson(400, "bad_request", "lines[] is required");
    }

    const onDate = body.on_date ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(onDate)) {
      return errorJson(400, "bad_request", "on_date must be YYYY-MM-DD");
    }

    const supabase = userClient(req);
    const { data: ruleSets, error } = await supabase
      .from("tax_rule_sets")
      .select(
        "id, version, name, effective_from, effective_to, rounding_mode, rules",
      )
      .eq("restaurant_id", caller.restaurantId);
    if (error) return internalError("calculate-tax", error);

    try {
      const ruleSet = selectRuleSet((ruleSets ?? []) as RuleSet[], onDate);
      const result = calculate(ruleSet, body.lines);
      return json(200, result);
    } catch (err) {
      if (err instanceof TaxEngineError || err instanceof MoneyError) {
        return errorJson(422, err.code, err.message);
      }
      throw err;
    }
  } catch (err) {
    return internalError("calculate-tax", err);
  }
});
