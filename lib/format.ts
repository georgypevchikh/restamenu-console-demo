/** Display helpers for integer minor-unit amounts (source of truth: the tax
 * engine works in cents; formatting happens only at the edge of the UI). */

export function formatMinor(minor: number, currency = "EUR"): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100);
  const cents = String(abs - whole * 100).padStart(2, "0");
  return `${sign}${whole}.${cents} ${currency}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
