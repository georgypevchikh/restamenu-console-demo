import { describe, expect, it } from "vitest";
import {
  fitPdfText,
  paginatePdfRows,
  pdfContentDisposition,
  sanitizePdfFilename,
  sanitizePdfText,
} from "../supabase/functions/_shared/core/pdf-layout.ts";

function codePoints(value: string): ReadonlySet<number> {
  return new Set(Array.from(value, (character) => character.codePointAt(0)!));
}

describe("PDF pagination", () => {
  it.each([
    [1, [1]],
    [40, [28, 12]],
    [250, [28, 28, 28, 28, 28, 28, 28, 28, 26]],
  ])("plans %i rows without loss or overlap", (count, expectedSizes) => {
    const rows = Array.from({ length: count }, (_, index) => index + 1);
    const pages = paginatePdfRows(rows);

    expect(pages.map((page) => page.rows.length)).toEqual(expectedSizes);
    expect(pages.flatMap((page) => page.rows)).toEqual(rows);
    expect(pages.map((page) => page.pageNumber)).toEqual(
      Array.from({ length: pages.length }, (_, index) => index + 1),
    );
    expect(pages.every((page) => page.totalPages === pages.length)).toBe(true);
    expect(pages.filter((page) => page.isLast)).toHaveLength(1);
    expect(pages.at(-1)?.isLast).toBe(true);
  });

  it("still creates a single empty page plan for defensive rendering", () => {
    expect(paginatePdfRows([])).toMatchObject([
      { pageNumber: 1, totalPages: 1, isLast: true, rows: [] },
    ]);
  });
});

describe("PDF text safety", () => {
  const supported = codePoints(
    " abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-...?" +
      "ĄČĘĖĮŠŲŪŽąčęėįšųūžПоставщикресторан",
  );

  it("preserves Lithuanian and Cyrillic while replacing emoji", () => {
    expect(sanitizePdfText("Šviežios daržovės / Поставщик 🙂", supported)).toBe(
      "Šviežios daržovės ? Поставщик ?",
    );
  });

  it("collapses controls and whitespace to a safe single line", () => {
    expect(sanitizePdfText("A\r\n\t  B", supported)).toBe("A B");
  });

  it("fits text deterministically with an ASCII suffix", () => {
    const monoMetrics = {
      supportedCodePoints: supported,
      widthOfTextAtSize: (text: string, size: number) => Array.from(text).length * size,
    };
    expect(fitPdfText("ABCDEFGHIJ", 1, 7, monoMetrics)).toBe("ABCD...");
    expect(fitPdfText("ABC", 1, 7, monoMetrics)).toBe("ABC");
  });
});

describe("PDF download filename", () => {
  it("removes CRLF, quotes, separators, and a duplicate extension", () => {
    expect(sanitizePdfFilename(' PO-2026/0002\r\nX-Bad: "yes".pdf ')).toBe(
      "PO-2026-0002-X-Bad-yes.pdf",
    );
  });

  it("falls back to a stable ASCII filename", () => {
    expect(sanitizePdfFilename("🙂🙂")).toBe("purchase-order.pdf");
  });

  it("produces a single quoted Content-Disposition header", () => {
    const header = pdfContentDisposition('PO-1"\r\nContent-Type:text/html');
    expect(header).toBe('attachment; filename="PO-1-Content-Type-text-html.pdf"');
    expect(header).not.toMatch(/[\r\n]/);
  });
});
