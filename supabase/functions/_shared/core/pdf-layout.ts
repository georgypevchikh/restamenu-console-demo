/** Pure layout and text-safety helpers for purchase-order PDFs. */

export const PDF_ROWS_PER_PAGE = 28;
const MAX_PDF_TEXT_CODEPOINTS = 1_000;
const MAX_FILENAME_BASENAME = 80;

export interface PdfPagePlan<T> {
  pageNumber: number;
  totalPages: number;
  isLast: boolean;
  rows: T[];
}

export interface PdfFontMetrics {
  supportedCodePoints: ReadonlySet<number>;
  widthOfTextAtSize(text: string, size: number): number;
}

/** Fixed-height rows make page boundaries deterministic and testable. */
export function paginatePdfRows<T>(
  rows: readonly T[],
  rowsPerPage = PDF_ROWS_PER_PAGE,
): PdfPagePlan<T>[] {
  if (!Number.isSafeInteger(rowsPerPage) || rowsPerPage <= 0) {
    throw new Error(
      `rowsPerPage must be a positive integer, got ${rowsPerPage}`,
    );
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  return Array.from({ length: totalPages }, (_, index) => ({
    pageNumber: index + 1,
    totalPages,
    isLast: index === totalPages - 1,
    rows: rows.slice(index * rowsPerPage, (index + 1) * rowsPerPage),
  }));
}

/**
 * Normalise whitespace/control characters and replace glyphs absent from the
 * embedded font. Roboto contains Latin Extended + Cyrillic; emoji deliberately
 * degrade to `?` instead of producing .notdef boxes or throwing at draw time.
 */
export function sanitizePdfText(
  value: unknown,
  supportedCodePoints: ReadonlySet<number>,
  fallback = "?",
): string {
  const normalized = String(value ?? "").normalize("NFC");
  const fallbackCodePoint = fallback.codePointAt(0);
  const safeFallback = fallbackCodePoint !== undefined &&
      supportedCodePoints.has(fallbackCodePoint)
    ? fallback
    : " ";

  let result = "";
  let count = 0;
  for (const character of normalized) {
    if (count >= MAX_PDF_TEXT_CODEPOINTS) break;
    count += 1;

    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      result += " ";
    } else {
      result += supportedCodePoints.has(codePoint) ? character : safeFallback;
    }
  }

  return result.replace(/\s+/g, " ").trim();
}

/** Fit a single-line label without drawing outside its column. */
export function fitPdfText(
  value: unknown,
  size: number,
  maxWidth: number,
  metrics: PdfFontMetrics,
): string {
  if (!(size > 0) || !(maxWidth > 0)) return "";

  const safe = sanitizePdfText(value, metrics.supportedCodePoints);
  if (metrics.widthOfTextAtSize(safe, size) <= maxWidth) return safe;

  const suffix = "...";
  const suffixWidth = metrics.widthOfTextAtSize(suffix, size);
  if (suffixWidth > maxWidth) return "";

  let fitted = "";
  let width = 0;
  for (const character of safe) {
    const characterWidth = metrics.widthOfTextAtSize(character, size);
    if (width + characterWidth + suffixWidth > maxWidth) break;
    fitted += character;
    width += characterWidth;
  }
  return `${fitted}${suffix}`;
}

/** ASCII-only filename safe for a quoted Content-Disposition parameter. */
export function sanitizePdfFilename(poNumber: unknown): string {
  const withoutExtension = String(poNumber ?? "").trim().replace(/\.pdf$/i, "");
  const ascii = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_FILENAME_BASENAME);

  return `${ascii || "purchase-order"}.pdf`;
}

export function pdfContentDisposition(poNumber: unknown): string {
  return `attachment; filename="${sanitizePdfFilename(poNumber)}"`;
}
