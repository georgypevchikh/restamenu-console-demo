/** Messaging provider adapter — Twilio calls are asserted via injected fetch. */

import { describe, it, expect, vi } from "vitest";
import {
  TwilioProvider,
  ConsoleProvider,
  createProvider,
  MessagingError,
} from "../supabase/functions/_shared/core/messaging.ts";

const CONFIG = {
  accountSid: "ACtest",
  authToken: "token",
  smsFrom: "+12025550000",
  whatsappFrom: "+14155238886",
};

function okFetch(body: unknown = { sid: "SM123" }) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status: 201 }),
  ) as unknown as typeof fetch;
}

describe("TwilioProvider", () => {
  it("sends SMS with plain E.164 addressing", async () => {
    const fetchMock = okFetch();
    const provider = new TwilioProvider(CONFIG, fetchMock);
    const result = await provider.send("+37060000000", "code 123456", "sms");

    expect(result).toEqual({ providerMessageId: "SM123", provider: "twilio" });
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json",
    );
    const params = new URLSearchParams(init.body as string);
    expect(params.get("To")).toBe("+37060000000");
    expect(params.get("From")).toBe("+12025550000");
    expect((init.headers as Record<string, string>).Authorization).toMatch(
      /^Basic /,
    );
  });

  it("prefixes whatsapp: for the WhatsApp channel", async () => {
    const fetchMock = okFetch();
    const provider = new TwilioProvider(CONFIG, fetchMock);
    await provider.send("+37060000000", "code", "whatsapp");
    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    expect(params.get("To")).toBe("whatsapp:+37060000000");
    expect(params.get("From")).toBe("whatsapp:+14155238886");
  });

  it("surfaces Twilio errors as MessagingError with detail", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Unverified number" }), {
          status: 400,
        }),
    ) as unknown as typeof fetch;
    const provider = new TwilioProvider(CONFIG, fetchMock);
    await expect(provider.send("+1", "x", "sms")).rejects.toThrow(
      /Unverified number/,
    );
  });
});

describe("provider selection", () => {
  it("console mode logs instead of sending", async () => {
    const logs: string[] = [];
    const provider = new ConsoleProvider((m) => logs.push(m));
    const result = await provider.send("+370600", "code 111222", "sms");
    expect(result.provider).toBe("console");
    expect(logs[0]).toContain("111222");
  });

  it("createProvider honours OTP_PROVIDER and validates twilio config", () => {
    expect(() => createProvider({})).toThrow(MessagingError);
    expect(() => createProvider({ OTP_PROVIDER: "typo" })).toThrow(
      "OTP_PROVIDER must be explicitly set",
    );
    expect(createProvider({ OTP_PROVIDER: "console" }).name).toBe("console");
    expect(() => createProvider({ OTP_PROVIDER: "twilio" })).toThrow(
      MessagingError,
    );
    expect(
      createProvider({
        OTP_PROVIDER: "twilio",
        TWILIO_ACCOUNT_SID: "AC",
        TWILIO_AUTH_TOKEN: "t",
        TWILIO_SMS_FROM: "+1",
        TWILIO_WHATSAPP_FROM: "+1",
      }).name,
    ).toBe("twilio");
  });
});
