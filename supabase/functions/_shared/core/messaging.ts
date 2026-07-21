/**
 * Provider-agnostic outbound messaging (the OTP transport).
 *
 * MessagingProvider is the seam: Twilio SMS and Twilio WhatsApp sandbox are
 * the real adapters, ConsoleProvider logs the message instead of sending it —
 * so the whole OTP flow works before any Twilio account exists, and tests
 * can swap providers without network access. Selection is by env
 * (OTP_PROVIDER=twilio|console) in the otp-request function.
 *
 * Uses global fetch only (Node ≥20 and Deno both provide it).
 */

export type MessagingChannel = "sms" | "whatsapp";

export interface SendResult {
  providerMessageId: string | null;
  provider: string;
}

export class MessagingError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "MessagingError";
  }
}

export interface MessagingProvider {
  readonly name: string;
  send(
    to: string,
    body: string,
    channel: MessagingChannel,
  ): Promise<SendResult>;
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  smsFrom: string; // e.g. +12025551234
  whatsappFrom: string; // sandbox number, e.g. +14155238886
}

/**
 * Plain Twilio REST — no SDK. WhatsApp sandbox uses the same Messages
 * endpoint with whatsapp:-prefixed addresses; recipients must have joined
 * the sandbox first (documented in docs/SETUP.md).
 */
export class TwilioProvider implements MessagingProvider {
  readonly name = "twilio";

  constructor(
    private config: TwilioConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(
    to: string,
    body: string,
    channel: MessagingChannel,
  ): Promise<SendResult> {
    const from = channel === "whatsapp"
      ? `whatsapp:${this.config.whatsappFrom}`
      : this.config.smsFrom;
    const toAddr = channel === "whatsapp" ? `whatsapp:${to}` : to;

    const url =
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
    const auth = btoa(`${this.config.accountSid}:${this.config.authToken}`);

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: toAddr, From: from, Body: body })
        .toString(),
    });

    const json = (await res.json().catch(() => null)) as
      | Record<string, unknown>
      | null;

    if (!res.ok) {
      const detail = json?.["message"] ?? `HTTP ${res.status}`;
      throw new MessagingError(
        "twilio_send_failed",
        `Twilio ${channel} send failed: ${detail}`,
      );
    }

    return {
      providerMessageId: (json?.["sid"] as string) ?? null,
      provider: this.name,
    };
  }
}

/**
 * Demo/dev fallback: the "delivery" is a structured log line in the Edge
 * Function logs. Deliberately loud about being a non-delivery.
 */
export class ConsoleProvider implements MessagingProvider {
  readonly name = "console";

  constructor(private log: (msg: string) => void = console.log) {}

  send(
    to: string,
    body: string,
    channel: MessagingChannel,
  ): Promise<SendResult> {
    this.log(
      `[ConsoleProvider] ${channel} to ${to}: ${body} (not actually sent)`,
    );
    return Promise.resolve({
      providerMessageId: `console-${Date.now()}`,
      provider: this.name,
    });
  }
}

export interface ProviderEnv {
  OTP_PROVIDER?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_SMS_FROM?: string;
  TWILIO_WHATSAPP_FROM?: string;
}

export function createProvider(env: ProviderEnv): MessagingProvider {
  if (env.OTP_PROVIDER === "console") {
    return new ConsoleProvider();
  }
  if (env.OTP_PROVIDER === "twilio") {
    const {
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN,
      TWILIO_SMS_FROM,
      TWILIO_WHATSAPP_FROM,
    } = env;
    if (
      !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_SMS_FROM ||
      !TWILIO_WHATSAPP_FROM
    ) {
      throw new MessagingError(
        "twilio_not_configured",
        "OTP_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM, TWILIO_WHATSAPP_FROM",
      );
    }
    return new TwilioProvider({
      accountSid: TWILIO_ACCOUNT_SID,
      authToken: TWILIO_AUTH_TOKEN,
      smsFrom: TWILIO_SMS_FROM,
      whatsappFrom: TWILIO_WHATSAPP_FROM,
    });
  }
  throw new MessagingError(
    "otp_provider_not_configured",
    "OTP_PROVIDER must be explicitly set to twilio or console",
  );
}
