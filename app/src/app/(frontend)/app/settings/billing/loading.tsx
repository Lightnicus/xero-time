import { PageHeader } from '@/app/(frontend)/_components/PageHeader'

export default function BillingSettingsLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="narrow-page page-stack" role="status">
      <PageHeader
        breadcrumb={{ current: 'Invoice defaults', href: '/app/settings', label: 'Settings' }}
        description="Loading accounts and tax types from the connected Xero organisation…"
        title="Invoice defaults"
      />
      <div className="panel page-stack">
        <p className="muted-copy">Loading Xero invoice options…</p>
      </div>
    </div>
  )
}
