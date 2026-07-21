"use client";

import { useState, useTransition } from "react";
import {
  createOrder,
  type OrderLineDraft,
} from "@/app/dashboard/orders/actions";
import { majorPriceToMinor } from "@/lib/order-input";

export interface RequestForOrder {
  id: string;
  quantity: number;
  product_id: string;
  product_name: string;
  unit: string;
  category_name: string | null;
  suggested_price_minor: number | null; // primary supplier price, when known
}

/**
 * Groups pending purchase requests into a PO draft. Prices are editable —
 * the primary supplier's price prefills when the products table knows it.
 * The math shown here is a preview only; the authoritative calculation
 * happens in the calculate-tax Edge Function on submit.
 */
export default function OrderForm({
  requests,
}: {
  requests: RequestForOrder[];
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      requests.map((r) => [
        r.id,
        r.suggested_price_minor !== null
          ? (r.suggested_price_minor / 100).toFixed(2)
          : "",
      ]),
    ),
  );
  const [supplier, setSupplier] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const chosen = requests.filter((r) => selected[r.id]);

  function parsedPrice(requestId: string): number | null {
    try {
      return majorPriceToMinor(prices[requestId] ?? "");
    } catch {
      return null;
    }
  }

  const lines: OrderLineDraft[] = chosen.map((r) => ({
    request_id: r.id,
    product_id: r.product_id,
    description: r.product_name,
    category_name: r.category_name,
    quantity: String(r.quantity),
    unit: r.unit,
    unit_price_minor: parsedPrice(r.id) ?? -1,
  }));
  const linesJson = JSON.stringify(lines);

  const previewSubtotal = chosen.reduce(
    (sum, r) => sum + r.quantity * (parsedPrice(r.id) ?? 0),
    0,
  );

  function handleSubmit(formData: FormData) {
    setError(null);
    const missingPrice = chosen.find((r) => {
      const price = parsedPrice(r.id);
      return price === null || price <= 0;
    });
    if (chosen.length === 0) {
      setError("Select at least one request.");
      return;
    }
    if (missingPrice) {
      setError(`Set a unit price for ${missingPrice.product_name}.`);
      return;
    }
    startTransition(async () => {
      const result = await createOrder(formData);
      if (result?.error) setError(result.error);
    });
  }

  if (requests.length === 0) {
    return (
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        No pending requests to order. Create requests on the Requests page
        first.
      </p>
    );
  }

  return (
    <form action={handleSubmit}>
      <input type="hidden" name="lines_json" value={linesJson} />

      <div className="table-scroll" style={{ marginBottom: 12 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <th>Product</th>
              <th>Qty</th>
              <th>Category</th>
              <th style={{ width: 140 }}>Unit price (EUR)</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    checked={selected[r.id] ?? false}
                    onChange={(e) =>
                      setSelected({ ...selected, [r.id]: e.target.checked })
                    }
                    aria-label={`Include ${r.product_name}`}
                  />
                </td>
                <td>{r.product_name}</td>
                <td>
                  {r.quantity} {r.unit}
                </td>
                <td style={{ color: "var(--muted)" }}>
                  {r.category_name ?? "—"}
                </td>
                <td>
                  <input
                    type="number"
                    min="0.01"
                    max="90071992547409.91"
                    step="0.01"
                    value={prices[r.id] ?? ""}
                    onChange={(e) =>
                      setPrices({ ...prices, [r.id]: e.target.value })
                    }
                    disabled={!selected[r.id]}
                    aria-label={`Unit price for ${r.product_name}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="form-row" style={{ alignItems: "flex-end" }}>
        <div className="field" style={{ maxWidth: 280 }}>
          <label className="field-label" htmlFor="supplier_name">
            Supplier
          </label>
          <input
            id="supplier_name"
            name="supplier_name"
            placeholder="e.g. Fresh Farms Ltd"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            required
          />
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <span className="field-label">Preview subtotal (pre-tax)</span>
          <span style={{ padding: "8px 0", display: "inline-block" }}>
            {(previewSubtotal / 100).toFixed(2)} EUR
          </span>
        </div>
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? "Pricing…" : "Create purchase order"}
        </button>
      </div>

      {error && (
        <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>
          {error}
        </p>
      )}
    </form>
  );
}
