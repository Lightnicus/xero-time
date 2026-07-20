export default function BillingSettingsLoading() {
  return (
    <div aria-live="polite" className="narrow-page page-stack" role="status">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Billing setup</p>
          <h1>Invoice defaults</h1>
          <p>Loading accounts and tax types from the connected Xero organisation…</p>
        </div>
      </section>
      <div className="panel page-stack">
        <p className="muted-copy">Loading Xero invoice options…</p>
      </div>
    </div>
  )
}
