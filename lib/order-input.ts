import { isUuid } from "./uuid";

export interface OrderLineDraft {
  request_id: string | null;
  product_id: string | null;
  description: string;
  category_name: string | null;
  quantity: string;
  unit: string | null;
  unit_price_minor: number;
}

export class OrderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderInputError";
  }
}

const QUANTITY = /^\d+(?:\.\d{1,3})?$/;
const MAX_LINES = 250;
const MAX_PAYLOAD_CHARS = 256_000;

function optionalUuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isUuid(value)) {
    throw new OrderInputError(`${field} must be a UUID or null.`);
  }
  return value;
}

function boundedText(
  value: unknown,
  field: string,
  max: number,
  nullable = false,
): string | null {
  if (nullable && (value === null || value === undefined || value === "")) {
    return null;
  }
  if (typeof value !== "string") {
    throw new OrderInputError(`${field} must be text.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new OrderInputError(`${field} must be 1-${max} characters.`);
  }
  return normalized;
}

export function validateSupplierName(value: unknown): string {
  return boundedText(value, "Supplier name", 200) as string;
}

/** Convert a human-entered decimal major-unit price without float rounding. */
export function majorPriceToMinor(value: string): number {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new OrderInputError("Price must have at most 2 decimal places.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) {
    throw new OrderInputError("Price is out of range.");
  }
  return minor;
}

export function parseOrderLines(raw: string): OrderLineDraft[] {
  if (raw.length > MAX_PAYLOAD_CHARS) {
    throw new OrderInputError("Order line data is too large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OrderInputError("Malformed line data.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new OrderInputError("Select at least one request.");
  }
  if (parsed.length > MAX_LINES) {
    throw new OrderInputError(
      `An order may contain at most ${MAX_LINES} lines.`,
    );
  }

  return parsed.map((candidate, index) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new OrderInputError(`Line ${index + 1} must be an object.`);
    }
    const line = candidate as Record<string, unknown>;
    const quantity = line.quantity;
    if (typeof quantity !== "string" || !QUANTITY.test(quantity)) {
      throw new OrderInputError(
        `Line ${index + 1} quantity must be positive with at most 3 decimals.`,
      );
    }
    const quantityNumber = Number(quantity);
    if (
      !Number.isFinite(quantityNumber) ||
      quantityNumber <= 0 ||
      !Number.isSafeInteger(Math.round(quantityNumber * 1000))
    ) {
      throw new OrderInputError(`Line ${index + 1} quantity is out of range.`);
    }
    if (
      typeof line.unit_price_minor !== "number" ||
      !Number.isSafeInteger(line.unit_price_minor) ||
      line.unit_price_minor < 0
    ) {
      throw new OrderInputError(
        `Line ${index + 1} unit price must be a non-negative integer.`,
      );
    }

    return {
      request_id: optionalUuid(line.request_id, `Line ${index + 1} request_id`),
      product_id: optionalUuid(line.product_id, `Line ${index + 1} product_id`),
      description: boundedText(
        line.description,
        `Line ${index + 1} description`,
        300,
      ) as string,
      category_name: boundedText(
        line.category_name,
        `Line ${index + 1} category`,
        300,
        true,
      ),
      quantity,
      unit: boundedText(line.unit, `Line ${index + 1} unit`, 50, true),
      unit_price_minor: line.unit_price_minor,
    };
  });
}
