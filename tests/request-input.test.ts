import { describe, expect, it } from "vitest";
import { parsePurchaseRequestInput } from "../lib/request-input";

const VALID = {
  productId: "11111111-2000-4000-8000-000000000001",
  quantity: "1.250",
  priority: "urgent",
};

describe("purchase-request input", () => {
  it("accepts a bounded quantity and known priority", () => {
    expect(parsePurchaseRequestInput(VALID)).toEqual({
      ...VALID,
      quantity: 1.25,
    });
  });

  it.each([
    [{ ...VALID, productId: "bad" }, "Product"],
    [{ ...VALID, quantity: "0" }, "out of range"],
    [{ ...VALID, quantity: "-1" }, "at most 3"],
    [{ ...VALID, quantity: "1.0001" }, "at most 3"],
    [{ ...VALID, quantity: "1e3" }, "at most 3"],
    [{ ...VALID, priority: "super_urgent" }, "Priority"],
  ])("rejects malformed input %#", (input, message) => {
    expect(() => parsePurchaseRequestInput(input)).toThrow(message);
  });
});
