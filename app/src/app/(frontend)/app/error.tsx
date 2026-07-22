'use client'

import { PendingActionButton } from '@/app/(frontend)/_components/PendingControls'

export default function ApplicationError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="narrow-page page-stack">
      <section className="panel page-stack" role="alert">
        <p className="eyebrow">Connection problem</p>
        <h1>The latest application data could not be loaded</h1>
        <p>
          Check your network connection and try again. No time or billing change is assumed to have
          completed until its saved state is visible.
        </p>
        <div className="filter-actions">
          <PendingActionButton
            action={reset}
            className="button button-primary"
            pendingLabel="Retrying…"
          >
            Try again
          </PendingActionButton>
        </div>
      </section>
    </div>
  )
}
