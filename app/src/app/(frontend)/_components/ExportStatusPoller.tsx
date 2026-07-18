'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export function ExportStatusPoller({ active }: { active: boolean }) {
  const router = useRouter()
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let delay = 2_000
    let timeout: ReturnType<typeof setTimeout>
    const poll = () => {
      timeout = setTimeout(() => {
        if (cancelled) return
        router.refresh()
        delay = Math.min(Math.round(delay * 1.6), 15_000)
        poll()
      }, delay)
    }
    poll()
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [active, router])
  return active ? (
    <span className="status-polling" role="status">
      Status updates automatically
    </span>
  ) : null
}
