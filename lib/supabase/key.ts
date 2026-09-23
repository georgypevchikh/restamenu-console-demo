/**
 * Public Supabase API key for browser, server components and middleware.
 *
 * Prefers the new `sb_publishable_…` key; falls back to the legacy anon JWT so
 * local dev and CI (which still issue legacy keys) keep working. Both are
 * public by design — RLS, not the key, is the security boundary.
 */
export const SUPABASE_PUBLIC_KEY: string =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
