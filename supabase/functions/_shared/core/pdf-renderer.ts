/** Offline, paginated purchase-order rendering with embedded Unicode fonts. */

// deno-lint-ignore-file no-import-prefix -- Supabase Edge bundles pinned npm specifiers.

import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
} from "npm:pdf-lib@1.17.1";
import { minorToMajorString } from "./money.ts";
import { loadEmbeddedRobotoFonts } from "./pdf-fonts.ts";
import {
  fitPdfText,
  paginatePdfRows,
  type PdfFontMetrics,
  sanitizePdfText,
} from "./pdf-layout.ts";
import type {
  PdfPurchaseOrderLineRecord,
  PurchaseOrderPdfDocument,
} from "./pdf-service.ts";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const ROW_HEIGHT = 16;

const COLORS = {
  ink: rgb(0.13, 0.15, 0.19),
  muted: rgb(0.45, 0.49, 0.56),
  rule: rgb(0.85, 0.87, 0.9),
};

interface FontContext {
  regular: PDFFont;
  bold: PDFFont;
  regularMetrics: PdfFontMetrics;
  boldMetrics: PdfFontMetrics;
}

function metricsFor(font: PDFFont): PdfFontMetrics {
  return {
    supportedCodePoints: new Set(font.getCharacterSet()),
    widthOfTextAtSize: (text, size) => font.widthOfTextAtSize(text, size),
  };
}

function drawRule(page: PDFPage, y: number): void {
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: MARGIN + CONTENT_WIDTH, y },
    thickness: 0.5,
    color: COLORS.rule,
  });
}

function drawText(options: {
  page: PDFPage;
  fonts: FontContext;
  value: unknown;
  x: number;
  y: number;
  size?: number;
  bold?: boolean;
  color?: ReturnType<typeof rgb>;
  maxWidth?: number;
  right?: number;
}): void {
  const {
    page,
    fonts,
    value,
    x,
    y,
    size = 10,
    bold = false,
    color = COLORS.ink,
    maxWidth,
    right,
  } = options;
  const font = bold ? fonts.bold : fonts.regular;
  const metrics = bold ? fonts.boldMetrics : fonts.regularMetrics;
  const content = (
    maxWidth === undefined
      ? sanitizePdfText(value, metrics.supportedCodePoints)
      : fitPdfText(value, size, maxWidth, metrics)
  ) || "-";
  const drawX = right === undefined
    ? x
    : right - font.widthOfTextAtSize(content, size);

  page.drawText(content, { x: drawX, y, size, font, color });
}

function formatMoney(minor: number, currency: string): string {
  return `${minorToMajorString(minor)} ${currency}`;
}

function taxRate(line: PdfPurchaseOrderLineRecord): number | null {
  if (!line.tax_detail || typeof line.tax_detail !== "object") return null;
  const rate = (line.tax_detail as { rate_bps?: unknown }).rate_bps;
  return typeof rate === "number" && Number.isFinite(rate) ? rate : null;
}

function drawDocumentHeader(options: {
  page: PDFPage;
  fonts: FontContext;
  document: PurchaseOrderPdfDocument;
}): number {
  const { page, fonts, document } = options;
  let y = PAGE_HEIGHT - MARGIN;

  drawText({
    page,
    fonts,
    value: "PURCHASE ORDER",
    x: MARGIN,
    y,
    size: 20,
    bold: true,
    maxWidth: 300,
  });
  drawText({
    page,
    fonts,
    value: document.status.toUpperCase(),
    x: MARGIN,
    y,
    color: COLORS.muted,
    maxWidth: 120,
    right: MARGIN + CONTENT_WIDTH,
  });
  y -= 26;

  drawText({
    page,
    fonts,
    value: document.po_number,
    x: MARGIN,
    y,
    size: 12,
    bold: true,
    maxWidth: CONTENT_WIDTH,
  });
  y -= 30;

  drawText({
    page,
    fonts,
    value: document.restaurant_name,
    x: MARGIN,
    y,
    bold: true,
    maxWidth: 280,
  });
  drawText({
    page,
    fonts,
    value: `Date: ${String(document.created_at).slice(0, 10)}`,
    x: MARGIN,
    y,
    color: COLORS.muted,
    maxWidth: 175,
    right: MARGIN + CONTENT_WIDTH,
  });
  y -= 14;

  drawText({
    page,
    fonts,
    value: `Supplier: ${document.supplier_name}`,
    x: MARGIN,
    y,
    maxWidth: 300,
  });
  if (document.approved_at) {
    drawText({
      page,
      fonts,
      value: `Approved: ${String(document.approved_at).slice(0, 10)}`,
      x: MARGIN,
      y,
      color: COLORS.muted,
      maxWidth: 175,
      right: MARGIN + CONTENT_WIDTH,
    });
  }
  y -= 28;

  drawText({
    page,
    fonts,
    value: "DESCRIPTION",
    x: MARGIN,
    y,
    size: 8,
    bold: true,
    color: COLORS.muted,
  });
  drawText({
    page,
    fonts,
    value: "QTY",
    x: 250,
    y,
    size: 8,
    bold: true,
    color: COLORS.muted,
  });
  drawText({
    page,
    fonts,
    value: "UNIT PRICE",
    x: MARGIN,
    y,
    size: 8,
    bold: true,
    color: COLORS.muted,
    maxWidth: 70,
    right: 390,
  });
  drawText({
    page,
    fonts,
    value: "TAX",
    x: MARGIN,
    y,
    size: 8,
    bold: true,
    color: COLORS.muted,
    maxWidth: 70,
    right: 475,
  });
  drawText({
    page,
    fonts,
    value: "TOTAL",
    x: MARGIN,
    y,
    size: 8,
    bold: true,
    color: COLORS.muted,
    maxWidth: 65,
    right: MARGIN + CONTENT_WIDTH,
  });
  y -= 6;
  drawRule(page, y + 4);
  return y - 14;
}

function drawLineRow(options: {
  page: PDFPage;
  fonts: FontContext;
  line: PdfPurchaseOrderLineRecord;
  currency: string;
  y: number;
}): void {
  const { page, fonts, line, currency, y } = options;
  const description = line.category_name
    ? `${line.description} (${line.category_name})`
    : line.description;
  const quantity = `${line.quantity}${line.unit ? ` ${line.unit}` : ""}`;
  const rate = taxRate(line);
  const tax = rate === null
    ? formatMoney(line.tax_minor, currency)
    : `${formatMoney(line.tax_minor, currency)} (${(rate / 100).toFixed(1)}%)`;

  drawText({
    page,
    fonts,
    value: description,
    x: MARGIN,
    y,
    size: 9,
    maxWidth: 190,
  });
  drawText({ page, fonts, value: quantity, x: 250, y, size: 9, maxWidth: 65 });
  drawText({
    page,
    fonts,
    value: formatMoney(line.unit_price_minor, currency),
    x: MARGIN,
    y,
    size: 9,
    maxWidth: 72,
    right: 390,
  });
  drawText({
    page,
    fonts,
    value: tax,
    x: MARGIN,
    y,
    size: 9,
    maxWidth: 78,
    right: 475,
  });
  drawText({
    page,
    fonts,
    value: formatMoney(line.line_total_minor, currency),
    x: MARGIN,
    y,
    size: 9,
    maxWidth: 65,
    right: MARGIN + CONTENT_WIDTH,
  });
}

function drawTotals(options: {
  page: PDFPage;
  fonts: FontContext;
  document: PurchaseOrderPdfDocument;
  y: number;
}): void {
  const { page, fonts, document } = options;
  let y = options.y - 4;
  drawRule(page, y + 4);
  y -= 18;

  const totals: Array<[string, number, boolean]> = [
    ["Subtotal", document.subtotal_minor, false],
    ["Tax", document.tax_total_minor, false],
    ...(document.withholding_minor > 0
      ? [
        ["Withholding", -document.withholding_minor, false] as [
          string,
          number,
          boolean,
        ],
      ]
      : []),
    ["Total", document.total_minor, true],
  ];

  for (const [label, minor, bold] of totals) {
    drawText({
      page,
      fonts,
      value: label,
      x: 330,
      y,
      size: bold ? 11 : 9,
      bold,
      color: bold ? COLORS.ink : COLORS.muted,
      maxWidth: 100,
    });
    const value = minor < 0
      ? `-${formatMoney(-minor, document.currency)}`
      : formatMoney(minor, document.currency);
    drawText({
      page,
      fonts,
      value,
      x: MARGIN,
      y,
      size: bold ? 11 : 9,
      bold,
      maxWidth: 105,
      right: MARGIN + CONTENT_WIDTH,
    });
    y -= bold ? 20 : 15;
  }
}

function drawFooter(options: {
  page: PDFPage;
  fonts: FontContext;
  pageNumber: number;
  totalPages: number;
}): void {
  const { page, fonts, pageNumber, totalPages } = options;
  drawRule(page, 82);
  drawText({
    page,
    fonts,
    value:
      "Generated by Restamenu Console (demo) - sandbox document, not a commercial record.",
    x: MARGIN,
    y: 62,
    size: 7,
    color: COLORS.muted,
    maxWidth: 390,
  });
  drawText({
    page,
    fonts,
    value: `Page ${pageNumber} of ${totalPages}`,
    x: MARGIN,
    y: 62,
    size: 7,
    color: COLORS.muted,
    maxWidth: 80,
    right: MARGIN + CONTENT_WIDTH,
  });
}

export async function renderPurchaseOrderPdf(
  document: PurchaseOrderPdfDocument,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const embedded = await loadEmbeddedRobotoFonts();
  const regular = await pdf.embedFont(embedded.regular, { subset: true });
  const bold = await pdf.embedFont(embedded.bold, { subset: true });
  const fonts: FontContext = {
    regular,
    bold,
    regularMetrics: metricsFor(regular),
    boldMetrics: metricsFor(bold),
  };

  pdf.setTitle(`Purchase Order ${document.po_number}`);
  pdf.setAuthor("Restamenu Console");
  pdf.setCreator("Restamenu Console generate-po-pdf");
  pdf.setProducer("pdf-lib with embedded Roboto");
  const generatedAt = new Date(document.generated_at);
  pdf.setCreationDate(generatedAt);
  pdf.setModificationDate(generatedAt);

  for (const plan of paginatePdfRows(document.lines)) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = drawDocumentHeader({ page, fonts, document });
    for (const line of plan.rows) {
      drawLineRow({ page, fonts, line, currency: document.currency, y });
      y -= ROW_HEIGHT;
    }
    if (plan.isLast) drawTotals({ page, fonts, document, y });
    drawFooter({
      page,
      fonts,
      pageNumber: plan.pageNumber,
      totalPages: plan.totalPages,
    });
  }

  return new Uint8Array(await pdf.save());
}
