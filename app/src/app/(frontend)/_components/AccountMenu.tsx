'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useRef, useState } from 'react'

import { LogoutButton } from '@/app/(frontend)/_components/LogoutButton'
import type {
  NavigationActionDestination,
  NavigationLinkDestination,
} from '@/lib/member-app/navigation'

type AccountMenuProps = {
  destinations: readonly (NavigationActionDestination | NavigationLinkDestination)[]
  displayName: string
  roleLabel: string
}

const isActiveDestination = (pathname: string, href: string): boolean =>
  href === '/app' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)

export function AccountMenu({ destinations, displayName, roleLabel }: AccountMenuProps) {
  const pathname = usePathname()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const initial = displayName.trim().charAt(0).toUpperCase() || 'A'

  return (
    <div
      className="account-menu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }}
    >
      <button
        aria-controls="account-menu-panel"
        aria-expanded={open}
        className="account-menu-trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        <span aria-hidden="true" className="account-avatar">
          {initial}
        </span>
        <span className="account-copy">
          <strong>{displayName}</strong>
          <small>{roleLabel}</small>
        </span>
        <span aria-hidden="true" className="menu-chevron">
          ▾
        </span>
      </button>

      {open && (
        <div className="nav-popover account-popover" id="account-menu-panel">
          <div className="account-popover-heading">
            <strong>{displayName}</strong>
            <span>{roleLabel}</span>
          </div>
          {destinations.map((destination) =>
            destination.kind === 'link' ? (
              <Link
                aria-current={isActiveDestination(pathname, destination.href) ? 'page' : undefined}
                className="nav-popover-link"
                href={destination.href}
                key={destination.id}
                onClick={() => setOpen(false)}
              >
                {destination.label}
              </Link>
            ) : (
              <LogoutButton key={destination.id} />
            ),
          )}
        </div>
      )}
    </div>
  )
}
