'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useRef, useState } from 'react'

import { AccountMenu } from '@/app/(frontend)/_components/AccountMenu'
import { LogoutButton } from '@/app/(frontend)/_components/LogoutButton'
import type {
  MemberNavigation,
  NavigationDestinationGroup,
  NavigationLinkDestination,
} from '@/lib/member-app/navigation'

type AppNavigationProps = {
  displayName: string
  navigation: MemberNavigation
  roleLabel: string
}

const isActiveDestination = (pathname: string, href: string): boolean => {
  if (href === '/app') return pathname === href
  if (href === '/app/billing') {
    return pathname === href || pathname.startsWith('/app/billing/preview')
  }
  return pathname === href || pathname.startsWith(`${href}/`)
}

const destinationLabel = (destination: NavigationLinkDestination) => (
  <>
    {destination.label}
    {destination.leavesApp && (
      <span aria-hidden="true" className="external-destination-mark">
        ↗
      </span>
    )}
  </>
)

export function AppNavigation({ displayName, navigation, roleLabel }: AppNavigationProps) {
  const pathname = usePathname()
  const menuButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const mobileButtonRef = useRef<HTMLButtonElement>(null)
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const addTime = navigation.primaryDestinations.find(
    (destination) => destination.id === 'add-time',
  )
  const primaryLinks = navigation.primaryDestinations.filter(
    (destination) => destination.id !== 'add-time',
  )
  const advancedGroup = navigation.destinationGroups.find((group) => group.id === 'advanced')
  const visibleGroups = navigation.destinationGroups.filter((group) => group.id !== 'advanced')

  const groupDestinations = (group: NavigationDestinationGroup) =>
    group.id === 'settings' && advancedGroup
      ? [...group.destinations, ...advancedGroup.destinations]
      : group.destinations

  const groupIsActive = (group: NavigationDestinationGroup): boolean =>
    Boolean(
      (group.landing && isActiveDestination(pathname, group.landing.href)) ||
      groupDestinations(group).some((destination) =>
        isActiveDestination(pathname, destination.href),
      ),
    )

  const closeMenus = () => {
    setOpenGroup(null)
    setMobileOpen(false)
  }

  return (
    <div
      className="app-navigation-shell"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setOpenGroup(null)
        setMobileOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return

        if (mobileOpen) {
          event.preventDefault()
          setMobileOpen(false)
          mobileButtonRef.current?.focus()
          return
        }

        if (openGroup) {
          event.preventDefault()
          const activeTrigger = menuButtonRefs.current[openGroup]
          setOpenGroup(null)
          activeTrigger?.focus()
        }
      }}
    >
      <div className="desktop-navigation">
        <nav aria-label="Primary" className="app-nav">
          {primaryLinks.map((destination) => (
            <Link
              aria-current={isActiveDestination(pathname, destination.href) ? 'page' : undefined}
              className="app-nav-link"
              href={destination.href}
              key={destination.id}
            >
              {destination.label}
            </Link>
          ))}

          {visibleGroups.map((group) => {
            const open = openGroup === group.id
            const destinations = groupDestinations(group)

            return (
              <div
                className={group.landing ? 'nav-group nav-group-with-landing' : 'nav-group'}
                key={group.id}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setOpenGroup((current) => (current === group.id ? null : current))
                  }
                }}
              >
                {group.landing && (
                  <Link
                    aria-current={
                      isActiveDestination(pathname, group.landing.href) ? 'page' : undefined
                    }
                    className="nav-group-landing"
                    href={group.landing.href}
                  >
                    {group.label}
                  </Link>
                )}
                <button
                  aria-controls={`nav-group-${group.id}`}
                  aria-expanded={open}
                  aria-label={group.landing ? `Open ${group.label} menu` : undefined}
                  className={
                    groupIsActive(group) ? 'nav-group-trigger active' : 'nav-group-trigger'
                  }
                  onClick={() =>
                    setOpenGroup((current) => (current === group.id ? null : group.id))
                  }
                  ref={(element) => {
                    menuButtonRefs.current[group.id] = element
                  }}
                  type="button"
                >
                  {!group.landing && group.label}
                  <span aria-hidden="true" className="menu-chevron">
                    ▾
                  </span>
                </button>

                {open && (
                  <div className="nav-popover" id={`nav-group-${group.id}`}>
                    {destinations.map((destination, index) => (
                      <div key={destination.id}>
                        {group.id === 'settings' &&
                          advancedGroup &&
                          index === group.destinations.length && (
                            <span className="nav-popover-section">Advanced</span>
                          )}
                        <Link
                          aria-current={
                            isActiveDestination(pathname, destination.href) ? 'page' : undefined
                          }
                          aria-label={
                            destination.leavesApp
                              ? `${destination.label}, opens advanced administration`
                              : undefined
                          }
                          className="nav-popover-link"
                          href={destination.href}
                          onClick={() => setOpenGroup(null)}
                        >
                          {destinationLabel(destination)}
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </nav>

        {addTime && (
          <Link
            aria-current={isActiveDestination(pathname, addTime.href) ? 'page' : undefined}
            className="app-header-action"
            href={addTime.href}
          >
            <span aria-hidden="true">+</span>
            Add time
          </Link>
        )}

        <AccountMenu
          destinations={navigation.accountDestinations}
          displayName={displayName}
          roleLabel={roleLabel}
        />
      </div>

      <div className="mobile-navigation-controls">
        {addTime && (
          <Link
            aria-current={isActiveDestination(pathname, addTime.href) ? 'page' : undefined}
            className="app-header-action compact"
            href={addTime.href}
          >
            <span aria-hidden="true">+</span>
            <span>Add time</span>
          </Link>
        )}
        <button
          aria-controls="mobile-app-navigation"
          aria-expanded={mobileOpen}
          className="mobile-menu-trigger"
          onClick={() => setMobileOpen((current) => !current)}
          ref={mobileButtonRef}
          type="button"
        >
          <span aria-hidden="true" className="mobile-menu-icon">
            {mobileOpen ? '×' : '≡'}
          </span>
          Menu
        </button>
      </div>

      {mobileOpen && (
        <nav aria-label="Mobile primary" className="mobile-nav-panel" id="mobile-app-navigation">
          <div className="mobile-account-context">
            <strong>{displayName}</strong>
            <span>{roleLabel}</span>
          </div>

          {primaryLinks.map((destination) => (
            <Link
              aria-current={isActiveDestination(pathname, destination.href) ? 'page' : undefined}
              className="mobile-nav-link"
              href={destination.href}
              key={destination.id}
              onClick={closeMenus}
            >
              {destination.label}
            </Link>
          ))}

          {visibleGroups.map((group) => (
            <section className="mobile-nav-section" key={group.id}>
              <h2>{group.label}</h2>
              {group.landing && (
                <Link
                  aria-current={
                    isActiveDestination(pathname, group.landing.href) ? 'page' : undefined
                  }
                  className="mobile-nav-link"
                  href={group.landing.href}
                  onClick={closeMenus}
                >
                  {group.landing.label}
                </Link>
              )}
              {groupDestinations(group).map((destination, index) => (
                <div key={destination.id}>
                  {group.id === 'settings' &&
                    advancedGroup &&
                    index === group.destinations.length && (
                      <span className="mobile-nav-subheading">Advanced</span>
                    )}
                  <Link
                    aria-current={
                      isActiveDestination(pathname, destination.href) ? 'page' : undefined
                    }
                    className="mobile-nav-link"
                    href={destination.href}
                    onClick={closeMenus}
                  >
                    {destinationLabel(destination)}
                  </Link>
                </div>
              ))}
            </section>
          ))}

          <section className="mobile-nav-section mobile-account-actions">
            <h2>Account</h2>
            {navigation.accountDestinations.map((destination) =>
              destination.kind === 'link' ? (
                <Link
                  aria-current={
                    isActiveDestination(pathname, destination.href) ? 'page' : undefined
                  }
                  className="mobile-nav-link"
                  href={destination.href}
                  key={destination.id}
                  onClick={closeMenus}
                >
                  {destination.label}
                </Link>
              ) : (
                <LogoutButton key={destination.id} />
              ),
            )}
          </section>
        </nav>
      )}
    </div>
  )
}
