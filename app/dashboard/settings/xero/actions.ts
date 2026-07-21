"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { invokeEdge } from "@/lib/edge";

export async function connectXero(): Promise<{ error: string } | void> {
  const { status, json } = await invokeEdge("xero-oauth-start", {
    redirectTo: "/dashboard/settings/xero",
  });

  if (status === 503) {
    return { error: "Xero is not configured yet (missing function secrets)." };
  }
  if (status !== 200 || !json?.authorizeUrl) {
    return { error: `Could not start the Xero connection (${json?.error ?? status}).` };
  }

  redirect(json.authorizeUrl as string);
}

export async function importBills(): Promise<{ imported?: number; error?: string }> {
  const { status, json } = await invokeEdge("xero-sync", { action: "import_bills" });
  if (status === 200) {
    revalidatePath("/dashboard/settings/xero");
    return { imported: (json?.imported as number) ?? 0 };
  }
  return { error: (json?.message as string) ?? (json?.error as string) ?? `Import failed (${status})` };
}
