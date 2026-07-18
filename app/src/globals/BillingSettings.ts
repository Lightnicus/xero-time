import { ownerAdminOrBiller, ownerOrAdmin } from '@/access/roles'
import { auditGlobalChange } from '@/lib/audit/change-hooks'
import { isRecord, validateWholeNumber } from '@/lib/domain/validation'

import type { GlobalConfig, Validate } from 'payload'

const allowedLineTemplateTokens = new Set([
  'description',
  'projectCode',
  'projectName',
  'userName',
  'workDate',
])

const validateLineDescriptionTemplate = (value: unknown): string | true => {
  if (typeof value !== 'string' || value.trim() === '') return 'Enter a line description template.'
  if (!value.includes('{{description}}')) {
    return 'The template must contain {{description}} so every invoice line retains its time-entry description.'
  }

  const tokens = [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  )
  const unknownToken = tokens.find((token) => !allowedLineTemplateTokens.has(token))

  return unknownToken ? `Unknown template token {{${unknownToken}}}.` : true
}

const validatePaymentTerms: Validate<unknown> = (value) => {
  if (!isRecord(value)) return 'Configure payment terms.'
  const { basis, value: termValue } = value

  if (basis === 'days-after-invoice') {
    return validateWholeNumber(termValue, { max: 365, min: 0 })
  }

  if (basis === 'day-of-following-month') {
    return validateWholeNumber(termValue, { max: 31, min: 1 })
  }

  return 'Choose a supported payment-term basis.'
}

const validateMaxWaitInvoices: Validate<number> = (value) =>
  validateWholeNumber(value, { max: 20, min: 1 })

const validateMaxWaitLines: Validate<number> = (value) =>
  validateWholeNumber(value, { max: 1_000, min: 1 })

export const BillingSettings: GlobalConfig = {
  slug: 'billing-settings',
  label: 'Billing Settings',
  access: {
    read: ownerAdminOrBiller,
    readVersions: ownerOrAdmin,
    update: ownerOrAdmin,
  },
  admin: {
    description:
      'Defaults for future invoice previews and exports. Saved time and invoice snapshots are immutable.',
    group: 'Settings',
  },
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Xero invoice defaults',
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'defaultRevenueAccountCode',
                  type: 'text',
                  maxLength: 20,
                  admin: {
                    description:
                      'Leave blank until a revenue account is selected from the connected Xero organisation.',
                    placeholder: 'For example: 200',
                    width: '50%',
                  },
                  hooks: {
                    beforeValidate: [
                      ({ value }) =>
                        typeof value === 'string' ? value.trim().toUpperCase() : value,
                    ],
                  },
                },
                {
                  name: 'defaultTaxType',
                  type: 'text',
                  maxLength: 50,
                  admin: {
                    description:
                      'Xero TaxType selected from reference data. Leave blank until Xero is connected.',
                    placeholder: 'For example: OUTPUT2',
                    width: '50%',
                  },
                  hooks: {
                    beforeValidate: [
                      ({ value }) =>
                        typeof value === 'string' ? value.trim().toUpperCase() : value,
                    ],
                  },
                },
              ],
            },
            {
              name: 'lineAmountType',
              type: 'select',
              required: true,
              defaultValue: 'Exclusive',
              options: [
                { label: 'Tax exclusive', value: 'Exclusive' },
                { label: 'Tax inclusive', value: 'Inclusive' },
                { label: 'No tax', value: 'NoTax' },
              ],
              admin: {
                description: 'Sent explicitly on each new draft invoice.',
              },
            },
            {
              name: 'paymentTerms',
              type: 'group',
              required: true,
              defaultValue: {
                basis: 'days-after-invoice',
                value: 14,
              },
              validate: validatePaymentTerms,
              fields: [
                {
                  type: 'row',
                  fields: [
                    {
                      name: 'basis',
                      type: 'select',
                      required: true,
                      defaultValue: 'days-after-invoice',
                      options: [
                        { label: 'Days after invoice date', value: 'days-after-invoice' },
                        {
                          label: 'Day of the following month',
                          value: 'day-of-following-month',
                        },
                      ],
                      admin: { width: '50%' },
                    },
                    {
                      name: 'value',
                      type: 'number',
                      required: true,
                      defaultValue: 14,
                      min: 0,
                      max: 365,
                      admin: {
                        description:
                          'For following-month terms, enter a calendar day from 1 to 31.',
                        step: 1,
                        width: '50%',
                      },
                    },
                  ],
                },
              ],
            },
            {
              name: 'invoiceReferencePrefix',
              type: 'text',
              required: true,
              defaultValue: 'TIME-',
              maxLength: 30,
              admin: {
                description: 'Prefix for the stable application reference used in reconciliation.',
              },
              hooks: {
                beforeValidate: [
                  ({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
                ],
              },
            },
            {
              name: 'invoiceLineDescriptionTemplate',
              type: 'textarea',
              required: true,
              defaultValue: '{{description}}',
              maxLength: 1_000,
              validate: validateLineDescriptionTemplate,
              admin: {
                description:
                  'One Xero line is created per time entry. Supported tokens: {{description}}, {{projectCode}}, {{projectName}}, {{workDate}}, {{userName}}.',
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'defaultTrackingCategories',
                  type: 'json',
                  admin: {
                    description:
                      'Optional default array of {name, option} values. A project may replace this list.',
                    width: '50%',
                  },
                },
                {
                  name: 'requiredTrackingCategoryNames',
                  type: 'json',
                  admin: {
                    description:
                      'Optional array of category names that every invoice line must resolve.',
                    width: '50%',
                  },
                },
              ],
            },
          ],
        },
        {
          label: 'Export execution',
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'acceptingNewExports',
                  type: 'checkbox',
                  defaultValue: false,
                  required: true,
                  admin: {
                    description:
                      'Owner-controlled kill switch. Existing export history and queued work are retained.',
                    width: '33%',
                  },
                },
                {
                  name: 'processingEnabled',
                  type: 'checkbox',
                  defaultValue: false,
                  required: true,
                  admin: {
                    description:
                      'Allows queue workers to contact Xero. Disabling this preserves pending work for safe resumption.',
                    width: '33%',
                  },
                },
                {
                  name: 'waitForResultEnabled',
                  type: 'checkbox',
                  defaultValue: false,
                  required: true,
                  admin: {
                    description:
                      'Allows synchronous wait mode. Background exports can remain enabled independently.',
                    width: '34%',
                  },
                },
              ],
            },
            {
              name: 'xeroExportMode',
              type: 'select',
              required: true,
              defaultValue: 'background',
              options: [
                { label: 'Background', value: 'background' },
                { label: 'Wait for Xero', value: 'wait-for-result' },
              ],
              admin: {
                description:
                  'Both modes persist the same durable job. “Wait for Xero” may still finish in the background after a timeout or interruption.',
              },
            },
            {
              name: 'allowBillerModeOverride',
              type: 'checkbox',
              defaultValue: false,
              admin: {
                description:
                  'When disabled, billers cannot override the configured mode for an individual export.',
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'maxWaitInvoices',
                  type: 'number',
                  required: true,
                  defaultValue: 1,
                  min: 1,
                  max: 20,
                  validate: validateMaxWaitInvoices,
                  admin: {
                    description:
                      'A larger batch is forced to background mode regardless of the configured mode.',
                    step: 1,
                    width: '50%',
                  },
                },
                {
                  name: 'maxWaitLines',
                  type: 'number',
                  required: true,
                  defaultValue: 50,
                  min: 1,
                  max: 1_000,
                  validate: validateMaxWaitLines,
                  admin: {
                    description: 'Maximum total invoice lines allowed in “Wait for Xero” mode.',
                    step: 1,
                    width: '50%',
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
      auditGlobalChange('settings.billing-changed', [
        'acceptingNewExports',
        'allowBillerModeOverride',
        'defaultRevenueAccountCode',
        'defaultTaxType',
        'defaultTrackingCategories',
        'invoiceLineDescriptionTemplate',
        'invoiceReferencePrefix',
        'lineAmountType',
        'maxWaitInvoices',
        'maxWaitLines',
        'paymentTerms',
        'processingEnabled',
        'requiredTrackingCategoryNames',
        'waitForResultEnabled',
        'xeroExportMode',
      ]),
      auditGlobalChange('security.kill-switch-changed', [
        'acceptingNewExports',
        'processingEnabled',
        'waitForResultEnabled',
      ]),
    ],
  },
  versions: {
    max: 100,
  },
}
