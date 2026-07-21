"use server";

import { redirect } from "next/navigation";
import { invokeEdge } from "@/lib/edge";

/**
 * Kicks off a Stripe test-mode Checkout session via the Edge Function and
 * sends the browser there. The web tier never touches the Stripe key.
 */
export async function startCheckout(): Promise<{ error: string } | void> {
  const { status, json } = await invokeEdge("create-checkout-session", {});

  if (status === 503) {
    return { error: "Stripe is not configured yet (missing function secrets)." };
  }
  if (status !== 200 || !json?.url) {
    return { error: `Could not start checkout (${json?.error ?? status}).` };
  }

  redirect(json.url as string);
}
