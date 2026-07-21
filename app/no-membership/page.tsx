export default function NoMembershipPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <section className="card" style={{ width: "100%", maxWidth: 520 }}>
        <p style={{ fontSize: 30, marginBottom: 12 }} aria-hidden="true">
          🍽️
        </p>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>
          No restaurant access yet
        </h1>
        <p style={{ color: "var(--muted)", marginBottom: 20 }}>
          Your account is valid, but it is not assigned to a restaurant. Ask a
          restaurant manager to add your account, then sign in again.
        </p>
        <form action="/api/auth/signout" method="post">
          <button type="submit" className="btn-primary">
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
