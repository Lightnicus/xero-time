import { describe, expect, it } from 'vitest'

import {
  defaultAppHome,
  navigationForRole,
  type MemberNavigation,
} from '@/lib/member-app/navigation'

const destinationLabels = (navigation: MemberNavigation) => ({
  account: navigation.accountDestinations.map((destination) => destination.label),
  groups: navigation.destinationGroups.map((group) => ({
    destinations: [...(group.landing ? [group.landing] : []), ...group.destinations].map(
      (destination) => destination.label,
    ),
    label: group.label,
  })),
  primary: navigation.primaryDestinations.map((destination) => destination.label),
})

describe('member app navigation', () => {
  it('gives members only the time workflow and account destinations', () => {
    expect(destinationLabels(navigationForRole('member'))).toEqual({
      account: ['Profile & security', 'Sign out'],
      groups: [],
      primary: ['My time', 'Add time'],
    })
  })

  it('makes billing the biller home and only visible workflow', () => {
    const navigation = navigationForRole('biller')

    expect(navigation.homeHref).toBe('/app/billing')
    expect(destinationLabels(navigation)).toEqual({
      account: ['Profile & security', 'Sign out'],
      groups: [
        {
          destinations: ['Billing queue', 'Export history'],
          label: 'Billing',
        },
      ],
      primary: [],
    })
  })

  it.each(['admin', 'owner'] as const)('gives %s users the complete grouped workflow', (role) => {
    expect(destinationLabels(navigationForRole(role))).toEqual({
      account: ['Profile & security', 'Sign out'],
      groups: [
        {
          destinations: ['Billing queue', 'Export history'],
          label: 'Billing',
        },
        {
          destinations: ['People & invitations', 'Customer billing', 'Project billing'],
          label: 'Manage',
        },
        {
          destinations: ['Invoice defaults', 'Xero accounting'],
          label: 'Settings',
        },
        {
          destinations: ['Operations', 'Payload Admin'],
          label: 'Advanced',
        },
      ],
      primary: ['My time', 'Add time'],
    })
  })

  it('uses the expected default home for every role', () => {
    expect({
      admin: defaultAppHome('admin'),
      biller: defaultAppHome('biller'),
      member: defaultAppHome('member'),
      owner: defaultAppHome('owner'),
    }).toEqual({
      admin: '/app',
      biller: '/app/billing',
      member: '/app',
      owner: '/app',
    })
  })

  it('keeps every route and the non-link account action explicit', () => {
    const navigation = navigationForRole('owner')
    const hrefsByID = Object.fromEntries(
      [
        ...navigation.primaryDestinations,
        ...navigation.destinationGroups.flatMap((group) => [
          ...(group.landing ? [group.landing] : []),
          ...group.destinations,
        ]),
        ...navigation.accountDestinations.filter((destination) => destination.kind === 'link'),
      ].map((destination) => [destination.id, destination.href]),
    )
    const payloadAdmin = navigation.destinationGroups
      .flatMap((group) => group.destinations)
      .find((destination) => destination.id === 'payload-admin')

    expect(hrefsByID).toEqual({
      'add-time': '/app/time/new',
      'billing-queue': '/app/billing',
      customers: '/app/settings/customers',
      'export-history': '/app/billing/exports',
      'invoice-defaults': '/app/settings/billing',
      'my-time': '/app',
      operations: '/app/operations',
      'payload-admin': '/admin',
      people: '/app/settings/users',
      profile: '/app/profile',
      projects: '/app/settings/projects',
      'xero-accounting': '/app/settings/xero',
    })
    expect(payloadAdmin).toEqual({
      href: '/admin',
      id: 'payload-admin',
      kind: 'link',
      label: 'Payload Admin',
      leavesApp: true,
    })
    expect(navigation.accountDestinations.at(-1)).toEqual({
      id: 'sign-out',
      kind: 'action',
      label: 'Sign out',
    })
  })

  it('is safe to pass across the server-client boundary', () => {
    const navigation = navigationForRole('owner')

    expect(JSON.parse(JSON.stringify(navigation))).toEqual(navigation)
  })
})
