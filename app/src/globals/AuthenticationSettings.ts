import { ownerOrAdmin } from '@/access/roles'
import { auditGlobalChange } from '@/lib/audit/change-hooks'
import { isRecord, validateWholeNumber } from '@/lib/domain/validation'

import type { GlobalConfig, Validate } from 'payload'

const validateEmailPasswordEnabled: Validate<boolean> = (value) =>
  value === true ? true : 'Email/password must remain enabled as the recovery login method.'

const validateExternalSessionIdle: Validate<number> = (value) =>
  validateWholeNumber(value, { max: 43_200, min: 15 })

const validateExternalSessionAbsolute: Validate<number> = (value, { siblingData }) => {
  const baseValidation = validateWholeNumber(value, {
    max: 525_600,
    min: 60,
  })
  if (baseValidation !== true) return baseValidation

  const idle = isRecord(siblingData) ? siblingData.externalSessionIdleMinutes : undefined

  return typeof idle !== 'number' || (value as number) >= idle
    ? true
    : 'Absolute lifetime must be at least the idle lifetime.'
}

const validateHealthCheckAge: Validate<number> = (value) =>
  validateWholeNumber(value, { max: 720, min: 1 })

export const AuthenticationSettings: GlobalConfig = {
  slug: 'authentication-settings',
  label: 'Authentication Settings',
  access: {
    read: ownerOrAdmin,
    readVersions: ownerOrAdmin,
    update: ownerOrAdmin,
  },
  admin: {
    description:
      'Controls optional Xero identity sign-in and local external-session policy. Email/password recovery remains enabled.',
    group: 'Settings',
  },
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Login methods',
          fields: [
            {
              name: 'emailPasswordEnabled',
              type: 'checkbox',
              defaultValue: true,
              required: true,
              access: {
                update: () => false,
              },
              validate: validateEmailPasswordEnabled,
              admin: {
                description:
                  'Always enabled so the final owner retains a recovery path independent of Xero.',
                readOnly: true,
              },
            },
            {
              name: 'xeroIdentityLoginEnabled',
              type: 'checkbox',
              defaultValue: false,
              admin: {
                description:
                  'Enables identity-only “Sign in with Xero”. This does not affect the business accounting connection.',
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'xeroIdentityLinkingEnabled',
                  type: 'checkbox',
                  defaultValue: false,
                  admin: {
                    condition: (data) => isRecord(data) && data.xeroIdentityLoginEnabled === true,
                    description: 'Allows an authenticated user to link a Xero identity.',
                    width: '50%',
                  },
                },
                {
                  name: 'xeroIdentityInviteAcceptanceEnabled',
                  type: 'checkbox',
                  defaultValue: false,
                  admin: {
                    condition: (data) => isRecord(data) && data.xeroIdentityLoginEnabled === true,
                    description: 'Allows a valid invitation to be accepted using Xero identity.',
                    width: '50%',
                  },
                },
              ],
            },
            {
              name: 'xeroIdentityRolloutRoles',
              type: 'select',
              hasMany: true,
              defaultValue: ['owner', 'admin'],
              options: [
                { label: 'Owner', value: 'owner' },
                { label: 'Admin', value: 'admin' },
                { label: 'Biller', value: 'biller' },
                { label: 'Member', value: 'member' },
              ],
              admin: {
                condition: (data) => isRecord(data) && data.xeroIdentityLoginEnabled === true,
                description:
                  'Roles offered Xero identity sign-in during staged rollout. Local roles remain authoritative.',
              },
            },
          ],
        },
        {
          label: 'External sessions',
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'externalSessionIdleMinutes',
                  type: 'number',
                  required: true,
                  defaultValue: 10_080,
                  min: 15,
                  max: 43_200,
                  validate: validateExternalSessionIdle,
                  admin: {
                    description: 'Idle lifetime in minutes. Default: 7 days.',
                    step: 1,
                    width: '50%',
                  },
                },
                {
                  name: 'externalSessionAbsoluteMinutes',
                  type: 'number',
                  required: true,
                  defaultValue: 43_200,
                  min: 60,
                  max: 525_600,
                  validate: validateExternalSessionAbsolute,
                  admin: {
                    description: 'Maximum lifetime in minutes. Default: 30 days.',
                    step: 1,
                    width: '50%',
                  },
                },
              ],
            },
            {
              name: 'showSessionManagement',
              type: 'checkbox',
              defaultValue: true,
              admin: {
                description: 'Shows safe active-session metadata on the account-security page.',
              },
            },
          ],
        },
        {
          label: 'Health checks',
          fields: [
            {
              name: 'staleAccountingHealthCheckHours',
              type: 'number',
              required: true,
              defaultValue: 24,
              min: 1,
              max: 720,
              validate: validateHealthCheckAge,
              admin: {
                description:
                  'After a successful login, a non-blocking accounting health check may be queued when the last check is older than this. Identity tokens are never used.',
                step: 1,
              },
            },
          ],
        },
      ],
    },
  ],
  hooks: {
    afterChange: [
      auditGlobalChange('settings.authentication-changed', [
        'externalSessionAbsoluteMinutes',
        'externalSessionIdleMinutes',
        'showSessionManagement',
        'staleAccountingHealthCheckHours',
        'xeroIdentityInviteAcceptanceEnabled',
        'xeroIdentityLinkingEnabled',
        'xeroIdentityLoginEnabled',
        'xeroIdentityRolloutRoles',
      ]),
      auditGlobalChange('security.kill-switch-changed', [
        'xeroIdentityInviteAcceptanceEnabled',
        'xeroIdentityLinkingEnabled',
        'xeroIdentityLoginEnabled',
      ]),
    ],
  },
  versions: {
    max: 50,
  },
}
