import { isUuid } from "./uuid";

export const REQUEST_PRIORITIES = [
  "urgent",
  "normal",
  "whenever",
  "by_breakfast",
  "by_lunch",
  "by_dinner",
] as const;

export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];

const QUANTITY = /^\d+(?:\.\d{1,3})?$/;

export function parsePurchaseRequestInput(input: {
  productId: unknown;
  quantity: unknown;
  priority: unknown;
}): { productId: string; quantity: number; priority: RequestPriority } {
  if (!isUuid(input.productId)) {
    throw new Error("Product is invalid.");
  }
  if (typeof input.quantity !== "string" || !QUANTITY.test(input.quantity)) {
    throw new Error("Quantity must be positive with at most 3 decimal places.");
  }
  const quantity = Number(input.quantity);
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isSafeInteger(Math.round(quantity * 1000))
  ) {
    throw new Error("Quantity is out of range.");
  }
  if (
    typeof input.priority !== "string" ||
    !REQUEST_PRIORITIES.includes(input.priority as RequestPriority)
  ) {
    throw new Error("Priority is invalid.");
  }
  return {
    productId: input.productId,
    quantity,
    priority: input.priority as RequestPriority,
  };
}
