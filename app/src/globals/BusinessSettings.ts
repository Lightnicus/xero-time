import { authenticated, ownerOrAdmin } from '@/access/roles'
import { auditGlobalChange } from '@/lib/audit/change-hooks'
import {
  currencyOptions,
  timezoneOptions,
  validateCurrencyCode,
  validateLocale,
  validateIanaTimezone,
} from '@/lib/domain/validation'

import type { GlobalConfig } from 'payload'

export const BusinessSettings: GlobalConfig = {
  slug: 'business-settings',
  label: 'Business Settings',
  access: {
    read: authenticated,
    readVersions: ownerOrAdmin,
    update: ownerOrAdmin,
  },
  admin: {
    description:
      'Business-wide display defaults. Historical time and invoice snapshots are not rewritten when these values change.',
    group: 'Settings',
  },
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Business',
          fields: [
            {
              name: 'businessName',
              type: 'text',
              required: true,
              defaultValue: 'My Business',
              maxLength: 160,
              admin: {
                description: 'Displayed throughout the application and on internal reports.',
              },
              hooks: {
                beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim() : value)],
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'defaultTimezone',
                  type: 'select',
                  required: true,
                  defaultValue: 'Pacific/Auckland',
                  options: timezoneOptions,
                  validate: validateIanaTimezone,
                  admin: {
                    description:
                      'Fallback only. Each user and time entry may select another IANA timezone.',
                    width: '50%',
                  },
                },
                {
                  name: 'baseCurrency',
                  type: 'select',
                  required: true,
                  defaultValue: 'NZD',
                  options: currencyOptions,
                  validate: validateCurrencyCode,
                  admin: {
                    description: 'Default ISO currency for newly created customers and projects.',
                    width: '50%',
                  },
                },
              ],
            },
          ],
        },
        {
          label: 'Formatting',
          fields: [
            {
              name: 'locale',
              type: 'text',
              required: true,
              defaultValue: 'en-NZ',
              maxLength: 35,
              validate: validateLocale,
              admin: {
                description: 'BCP 47 locale used for application display, for example en-NZ.',
              },
              hooks: {
                beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim() : value)],
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'dateDisplayStyle',
                  type: 'select',
                  required: true,
                  defaultValue: 'medium',
                  options: [
                    { label: '18 Jul 2026', value: 'medium' },
                    { label: '18/07/2026', value: 'short' },
                    { label: '18 July 2026', value: 'long' },
                  ],
                  admin: { width: '50%' },
                },
                {
                  name: 'timeDisplayStyle',
                  type: 'select',
                  required: true,
                  defaultValue: '24-hour',
                  options: [
                    { label: '24-hour (14:30)', value: '24-hour' },
                    { label: '12-hour (2:30 pm)', value: '12-hour' },
                  ],
                  admin: { width: '50%' },
                },
              ],
            },
          ],
        },
        {
          label: 'Support',
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'supportEmail',
                  type: 'email',
                  admin: {
                    description: 'Optional address shown to users who need help.',
                    width: '50%',
                  },
                },
                {
                  name: 'supportPhone',
                  type: 'text',
                  maxLength: 50,
                  admin: { width: '50%' },
                  hooks: {
                    beforeValidate: [
                      ({ value }) => (typeof value === 'string' ? value.trim() : value),
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  hooks: {
    afterChange: [
      auditGlobalChange('settings.business-changed', [
        'baseCurrency',
        'businessName',
        'dateDisplayStyle',
        'defaultTimezone',
        'locale',
        'supportEmail',
        'supportPhone',
        'timeDisplayStyle',
      ]),
    ],
  },
  versions: {
    max: 50,
  },
}
