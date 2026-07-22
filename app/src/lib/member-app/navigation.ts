import type { UserRole } from '@/access/roles'

export type NavigationLinkDestination = {
  href: string
  id: string
  kind: 'link'
  label: string
  leavesApp?: true
}

export type NavigationActionDestination = {
  id: string
  kind: 'action'
  label: string
}

export type NavigationDestinationGroup = {
  destinations: readonly NavigationLinkDestination[]
  id: string
  label: string
  landing?: NavigationLinkDestination
}

export type MemberNavigation = {
  accountDestinations: readonly (NavigationActionDestination | NavigationLinkDestination)[]
  destinationGroups: readonly NavigationDestinationGroup[]
  homeHref: string
  primaryDestinations: readonly NavigationLinkDestination[]
}

const myTime = {
  href: '/app',
  id: 'my-time',
  kind: 'link',
  label: 'My time',
} as const satisfies NavigationLinkDestination

const addTime = {
  href: '/app/time/new',
  id: 'add-time',
  kind: 'link',
  label: 'Add time',
} as const satisfies NavigationLinkDestination

const billing = {
  destinations: [
    {
      href: '/app/billing/exports',
      id: 'export-history',
      kind: 'link',
      label: 'Export history',
    },
  ],
  id: 'billing',
  label: 'Billing',
  landing: {
    href: '/app/billing',
    id: 'billing-queue',
    kind: 'link',
    label: 'Billing queue',
  },
} as const satisfies NavigationDestinationGroup

const manage = {
  destinations: [
    {
      href: '/app/settings/users',
      id: 'people',
      kind: 'link',
      label: 'People & invitations',
    },
    {
      href: '/app/settings/customers',
      id: 'customers',
      kind: 'link',
      label: 'Customer billing',
    },
    {
      href: '/app/settings/projects',
      id: 'projects',
      kind: 'link',
      label: 'Project billing',
    },
  ],
  id: 'manage',
  label: 'Manage',
} as const satisfies NavigationDestinationGroup

const settings = {
  destinations: [
    {
      href: '/app/settings/billing',
      id: 'invoice-defaults',
      kind: 'link',
      label: 'Invoice defaults',
    },
    {
      href: '/app/settings/xero',
      id: 'xero-accounting',
      kind: 'link',
      label: 'Xero accounting',
    },
  ],
  id: 'settings',
  label: 'Settings',
} as const satisfies NavigationDestinationGroup

const advanced = {
  destinations: [
    {
      href: '/app/operations',
      id: 'operations',
      kind: 'link',
      label: 'Operations',
    },
    {
      href: '/admin',
      id: 'payload-admin',
      kind: 'link',
      label: 'Payload Admin',
      leavesApp: true,
    },
  ],
  id: 'advanced',
  label: 'Advanced',
} as const satisfies NavigationDestinationGroup

const accountDestinations = [
  {
    href: '/app/profile',
    id: 'profile',
    kind: 'link',
    label: 'Profile & security',
  },
  {
    id: 'sign-out',
    kind: 'action',
    label: 'Sign out',
  },
] as const satisfies readonly (NavigationActionDestination | NavigationLinkDestination)[]

const navigationByRole = {
  admin: {
    accountDestinations,
    destinationGroups: [billing, manage, settings, advanced],
    homeHref: '/app',
    primaryDestinations: [myTime, addTime],
  },
  biller: {
    accountDestinations,
    destinationGroups: [billing],
    homeHref: '/app/billing',
    primaryDestinations: [],
  },
  member: {
    accountDestinations,
    destinationGroups: [],
    homeHref: '/app',
    primaryDestinations: [myTime, addTime],
  },
  owner: {
    accountDestinations,
    destinationGroups: [billing, manage, settings, advanced],
    homeHref: '/app',
    primaryDestinations: [myTime, addTime],
  },
} as const satisfies Record<UserRole, MemberNavigation>

export function defaultAppHome(role: UserRole): string {
  return navigationByRole[role].homeHref
}

export function navigationForRole(role: UserRole): MemberNavigation {
  return navigationByRole[role]
}
