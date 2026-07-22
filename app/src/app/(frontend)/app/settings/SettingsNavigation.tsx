'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

type SettingsLink = {
  href: string
  label: string
  leavesApp?: boolean
}

const workflowLinks: SettingsLink[] = [
  { href: '/app/settings/users', label: 'People & invitations' },
  { href: '/app/settings/customers', label: 'Customer billing' },
  { href: '/app/settings/projects', label: 'Project billing' },
  { href: '/app/settings/billing', label: 'Invoice defaults' },
  { href: '/app/settings/xero', label: 'Xero accounting' },
]

const advancedLinks: SettingsLink[] = [
  { href: '/app/operations', label: 'Operations' },
  { href: '/admin', label: 'Payload Admin', leavesApp: true },
]

const isCurrentPath = (pathname: string, href: string): boolean =>
  href === '/app/settings'
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`)

function NavigationLink({ href, label, leavesApp, pathname }: SettingsLink & { pathname: string }) {
  const current = isCurrentPath(pathname, href)

  return (
    <Link
      aria-current={current ? 'page' : undefined}
      aria-label={leavesApp ? `${label}, opens advanced administration` : undefined}
      href={href}
    >
      {label}
      {leavesApp && <span aria-hidden="true">↗</span>}
    </Link>
  )
}

function NavigationGroups({ pathname }: { pathname: string }) {
  return (
    <>
      <div className="settings-nav-group">
        <span className="settings-nav-label">Workflows</span>
        {workflowLinks.map((item) => (
          <NavigationLink key={item.href} pathname={pathname} {...item} />
        ))}
      </div>
      <div className="settings-nav-group settings-nav-advanced">
        <span className="settings-nav-label">Advanced</span>
        {advancedLinks.map((item) => (
          <NavigationLink key={item.href} pathname={pathname} {...item} />
        ))}
      </div>
    </>
  )
}

export function SettingsNavigation() {
  const pathname = usePathname()

  return (
    <aside className="settings-navigation" aria-label="Settings navigation">
      <nav aria-label="Settings pages" className="settings-nav-desktop">
        <NavigationLink href="/app/settings" label="Settings overview" pathname={pathname} />
        <NavigationGroups pathname={pathname} />
      </nav>

      <details className="settings-nav-mobile">
        <summary>Settings navigation</summary>
        <nav aria-label="Settings pages">
          <NavigationLink href="/app/settings" label="Settings overview" pathname={pathname} />
          <NavigationGroups pathname={pathname} />
        </nav>
      </details>
    </aside>
  )
}
