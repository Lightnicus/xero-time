export default function FrontendLoading() {
  return (
    <main className="auth-page">
      <section aria-busy="true" aria-live="polite" className="auth-card" role="status">
        <div className="brand-mark" aria-hidden="true">
          PT
        </div>
        <p className="eyebrow">Project Time</p>
        <h1>Loading…</h1>
        <p className="muted-copy">Preparing the next screen.</p>
      </section>
    </main>
  )
}
