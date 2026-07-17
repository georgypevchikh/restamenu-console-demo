"use client";

import { useRef } from "react";
import { createRequest } from "@/app/dashboard/requests/actions";
import type { Product } from "@/lib/types";

export default function NewRequestForm({ products }: { products: Product[] }) {
  const ref = useRef<HTMLFormElement>(null);

  async function handleSubmit(formData: FormData) {
    await createRequest(formData);
    ref.current?.reset();
  }

  return (
    <form ref={ref} action={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 11, color: "var(--muted)" }}>Product</label>
        <select name="product_id" required style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--fg)", fontSize: 13 }}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 11, color: "var(--muted)" }}>Qty</label>
        <input name="quantity" type="number" min={1} defaultValue={1} required style={{ width: 70, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--fg)", fontSize: 13 }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 11, color: "var(--muted)" }}>Priority</label>
        <select name="priority" style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--fg)", fontSize: 13 }}>
          <option value="urgent">🚨 urgent</option>
          <option value="normal">normal</option>
          <option value="whenever">whenever</option>
        </select>
      </div>
      <button type="submit" className="btn-primary" style={{ padding: "6px 14px", fontSize: 13 }}>
        + New request
      </button>
    </form>
  );
}
