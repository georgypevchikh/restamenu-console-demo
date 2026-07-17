"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";
import { createRequest } from "@/app/dashboard/requests/actions";
import type { Product } from "@/lib/types";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending}>
      {pending ? "Adding…" : "Add request"}
    </button>
  );
}

export default function NewRequestForm({ products }: { products: Product[] }) {
  const ref = useRef<HTMLFormElement>(null);

  async function handleSubmit(formData: FormData) {
    await createRequest(formData);
    ref.current?.reset();
  }

  return (
    <form ref={ref} action={handleSubmit} className="form-row">
      <div className="field">
        <label className="field-label" htmlFor="product_id">Product</label>
        <select id="product_id" name="product_id" required>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.unit})
            </option>
          ))}
        </select>
      </div>

      <div className="field" style={{ maxWidth: 90 }}>
        <label className="field-label" htmlFor="quantity">Qty</label>
        <input id="quantity" name="quantity" type="number" min={1} defaultValue={1} required />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="priority">Priority</label>
        <select id="priority" name="priority" defaultValue="urgent">
          <option value="urgent">Urgent</option>
          <option value="normal">Normal</option>
          <option value="whenever">Whenever</option>
        </select>
      </div>

      <SubmitButton />
    </form>
  );
}
