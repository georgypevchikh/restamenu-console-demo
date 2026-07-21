/**
 * Server-side guard for Supabase/PostgREST responses.
 *
 * A failed query must never be rendered as an empty collection, a free plan,
 * or a missing document. We log the database diagnostic on the server and
 * throw a stable, non-sensitive error for the dashboard error boundary.
 */
export interface SupabaseQueryError {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

export function assertQuerySucceeded(
  error: SupabaseQueryError | null,
  operation: string,
): asserts error is null {
  if (!error) return;

  console.error("Supabase query failed", {
    operation,
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });

  throw new Error(`Could not ${operation}. Please try again.`);
}
