import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_PUBLIC_KEY } from "./key";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    SUPABASE_PUBLIC_KEY
  );
}
