export default function ApplicationLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="narrow-page page-stack" role="status">
      <section className="panel page-stack">
        <p className="eyebrow">Project Time</p>
        <h1>Loading your workspace…</h1>
        <p className="muted-copy">Retrieving the latest time and billing state.</p>
      </section>
    </div>
  )
}
