import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page">
      <div className="card" style={{ maxWidth: 640 }}>
        <h1 className="page-title" style={{ marginBottom: 8 }}>
          Page not found
        </h1>
        <p style={{ color: "var(--muted)", marginBottom: 16 }}>
          The page you are looking for does not exist.
        </p>
        <Link href="/dashboard" className="btn-primary">
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
