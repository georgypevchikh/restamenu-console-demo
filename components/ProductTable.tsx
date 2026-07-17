import type { Product } from "@/lib/types";

interface Props {
  products: Product[];
}

export default function ProductTable({ products }: Props) {
  if (products.length === 0) {
    return <div className="empty">No products found for this restaurant.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th>Category</th>
          <th>Unit</th>
          <th>Min qty</th>
          <th>Stock</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {products.map((p) => {
          const lowStock = p.current_stock !== null && p.current_stock <= p.min_quantity;
          return (
            <tr key={p.id}>
              <td style={{ fontWeight: 500 }}>
                {p.categories?.icon && <span style={{ marginRight: 6 }}>{p.categories.icon}</span>}
                {p.name}
              </td>
              <td style={{ color: "var(--muted)" }}>{p.categories?.name ?? "—"}</td>
              <td>{p.unit}{p.volume ? ` / ${p.volume}${p.volume_unit}` : ""}</td>
              <td>{p.min_quantity}</td>
              <td style={{ color: lowStock ? "var(--warning)" : undefined }}>
                {p.current_stock ?? "—"}
              </td>
              <td>
                {lowStock ? (
                  <span className="badge badge-urgent">Low</span>
                ) : (
                  <span className="badge badge-bought">OK</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
