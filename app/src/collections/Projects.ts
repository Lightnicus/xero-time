import { ValidationError } from 'payload'

import { adminOnly, financialField, readBusinessDirectory } from '@/access/domain'
import { ownerOrAdmin } from '@/access/roles'
import { auditCollectionChange } from '@/lib/audit/change-hooks'
import { formatScaledAmount } from '@/lib/domain/money'
import {
  DEFAULT_CURRENCY,
  currencyOptions,
  isRecord,
  normalizeCurrencyCode,
  relationshipID,
  validateCurrencyCode,
  validateScaledInteger,
} from '@/lib/domain/validation'
import { attributeChange, attributionFields } from '@/lib/payload/attribution'

import type {
  CollectionConfig,
  CollectionBeforeValidateHook,
  CollectionSlug,
  FilterOptions,
  PayloadRequest,
  Validate,
} from 'payload'

const CUSTOMERS_SLUG = 'customers' as CollectionSlug

type ProjectHookDocument = Record<string, unknown> & { id: number | string }

const validateProjectCode: Validate<string> = (value) =>
  typeof value === 'string' && /^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(value)
    ? true
    : 'Use 1–40 uppercase letters, numbers, underscores, or hyphens.'

const validateHourlyRate: Validate<number> = (value) =>
  validateScaledInteger(value) === true
    ? true
    : 'Enter a non-negative hourly rate with no more than four decimal places.'

const activeOrCurrentCustomer: FilterOptions = async ({ id, req }) => {
  const activeCustomer = { status: { equals: 'active' } }
  if (typeof id === 'undefined') return activeCustomer

  try {
    const existingProject = await req.payload.findByID({
      collection: 'projects' as CollectionSlug,
      id,
      depth: 0,
      overrideAccess: true,
      req,
    })
    const existingCustomerID = relationshipID(
      isRecord(existingProject) ? existingProject.customer : null,
    )

    return existingCustomerID === null
      ? activeCustomer
      : {
          or: [activeCustomer, { id: { equals: existingCustomerID } }],
        }
  } catch {
    return activeCustomer
  }
}

const projectValidationError = (path: string, message: string, req: PayloadRequest): never => {
  throw new ValidationError({
    collection: 'projects',
    errors: [{ message, path }],
    req,
  })
}

const commercialFields = [
  'currency',
  'hourlyRateScaled',
  'revenueAccountCode',
  'taxType',
  'trackingCategories',
] as const

const protectCommercialChanges: import('payload').CollectionBeforeChangeHook<
  ProjectHookDocument
> = async ({ data, operation, originalDoc, req }) => {
  if (operation !== 'update') return data
  const changed = commercialFields.some(
    (field) =>
      Object.hasOwn(data, field) &&
      JSON.stringify(data[field] ?? null) !== JSON.stringify(originalDoc?.[field] ?? null),
  )
  if (!changed) return data
  const projectID = originalDoc?.id
  if (typeof projectID !== 'string' && typeof projectID !== 'number') return data
  const entries = await req.payload.find({
    collection: 'time-entries',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [{ project: { equals: projectID } }, { billingStatus: { equals: 'unbilled' } }],
    },
  })
  if (entries.docs.length === 0) return data
  const reason = data.commercialChangeReason
  if (
    data.confirmUnbilledImpact !== true ||
    typeof reason !== 'string' ||
    reason.trim().length < 10
  ) {
    return projectValidationError(
      'confirmUnbilledImpact',
      'Unbilled entries exist. Confirm that saved snapshots stay unchanged and enter a commercial-change reason.',
      req,
    )
  }
  req.context = { ...(req.context ?? {}), auditReason: reason.trim() }
  return data
}

/** Enforces the currency boundary at write time instead of relying on the admin form. */
const validateCustomerCurrency: CollectionBeforeValidateHook<ProjectHookDocument> = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (!data) return data

  const merged = { ...originalDoc, ...data }
  const customerID = relationshipID(merged.customer)
  const originalCustomerID = relationshipID(originalDoc?.customer)
  const customerChanged =
    operation === 'create' || String(customerID) !== String(originalCustomerID)

  if (customerID === null) return data

  let customer: unknown

  try {
    customer = await req.payload.findByID({
      collection: CUSTOMERS_SLUG,
      id: customerID,
      depth: 0,
      overrideAccess: true,
      req,
    })
  } catch {
    return projectValidationError('customer', 'Select an existing customer.', req)
  }

  if (!isRecord(customer)) {
    return projectValidationError('customer', 'Select an existing customer.', req)
  }

  if (customerChanged && customer.status !== 'active') {
    return projectValidationError(
      'customer',
      'New projects can only be assigned to an active customer.',
      req,
    )
  }

  const customerCurrency = customer.currency
  const projectCurrency = normalizeCurrencyCode(merged.currency)

  if (
    typeof customerCurrency !== 'string' ||
    typeof projectCurrency !== 'string' ||
    projectCurrency !== customerCurrency
  ) {
    return projectValidationError(
      'currency',
      `Project currency must match the customer currency${
        typeof customerCurrency === 'string' ? ` (${customerCurrency})` : ''
      }.`,
      req,
    )
  }

  return data
}

export const Projects: CollectionConfig = {
  slug: 'projects' as CollectionSlug,
  labels: {
    plural: 'Projects',
    singular: 'Project',
  },
  access: {
    admin: adminOnly,
    create: ownerOrAdmin,
    delete: () => false,
    read: readBusinessDirectory,
    readVersions: ownerOrAdmin,
    update: ownerOrAdmin,
  },
  admin: {
    defaultColumns: ['code', 'name', 'customer', 'status', 'currency', 'hourlyRateScaled'],
    description:
      'Projects define the customer, currency, and billing defaults snapshotted onto each new time entry.',
    group: 'Customers',
    listSearchableFields: ['name', 'code', 'description'],
    useAsTitle: 'name',
  },
  defaultSort: 'code',
  disableBulkDelete: true,
  disableDuplicate: true,
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Project',
          fields: [
            {
              name: 'customer',
              type: 'relationship',
              relationTo: CUSTOMERS_SLUG,
              required: true,
              index: true,
              filterOptions: activeOrCurrentCustomer,
              admin: {
                allowCreate: false,
                description:
                  'Currency is validated against this customer when the project is saved.',
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'name',
                  type: 'text',
                  required: true,
                  index: true,
                  maxLength: 200,
                  admin: { width: '67%' },
                  hooks: {
                    beforeValidate: [
                      ({ value }) => (typeof value === 'string' ? value.trim() : value),
                    ],
                  },
                },
                {
                  name: 'code',
                  type: 'text',
                  required: true,
                  unique: true,
                  index: true,
                  maxLength: 40,
                  validate: validateProjectCode,
                  admin: {
                    description: 'Stable short code used in search and invoice descriptions.',
                    width: '33%',
                  },
                  hooks: {
                    beforeValidate: [
                      ({ value }) =>
                        typeof value === 'string'
                          ? value.trim().toUpperCase().replaceAll(/\s+/g, '-')
                          : value,
                    ],
                  },
                },
              ],
            },
            {
              name: 'description',
              type: 'textarea',
              maxLength: 5_000,
              hooks: {
                beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim() : value)],
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'status',
                  type: 'select',
                  required: true,
                  defaultValue: 'active',
                  index: true,
                  options: [
                    { label: 'Active', value: 'active' },
                    { label: 'Archived', value: 'archived' },
                  ],
                  admin: {
                    description:
                      'Archived projects remain attached to historical entries but cannot receive new time.',
                    width: '25%',
                  },
                },
                {
                  name: 'currency',
                  type: 'select',
                  required: true,
                  defaultValue: DEFAULT_CURRENCY,
                  index: true,
                  options: currencyOptions,
                  validate: validateCurrencyCode,
                  admin: {
                    description: 'Must equal the selected customer currency.',
                    width: '25%',
                  },
                  hooks: {
                    beforeValidate: [({ value }) => normalizeCurrencyCode(value)],
                  },
                },
                {
                  name: 'hourlyRateScaled',
                  label: 'Hourly rate',
                  type: 'number',
                  required: true,
                  min: 0,
                  defaultValue: 0,
                  validate: validateHourlyRate,
                  access: {
                    read: financialField,
                  },
                  admin: {
                    components: {
                      Cell: '/components/admin/ScaledCurrencyCell',
                      Field: '/components/admin/ScaledCurrencyField',
                    },
                    description:
                      'API and database value stored as an integer in ten-thousandths of a currency unit. The admin editor converts ordinary currency values automatically.',
                    custom: {
                      inputDescription:
                        'Enter the hourly rate in the project currency, for example 150.00. Up to four decimal places are supported.',
                    },
                    disableGroupBy: true,
                    disableListFilter: true,
                    width: '50%',
                  },
                },
                {
                  name: 'hourlyRateDisplay',
                  type: 'text',
                  virtual: true,
                  access: { read: financialField },
                  admin: { hidden: true },
                  hooks: {
                    afterRead: [
                      ({ siblingData }) =>
                        isRecord(siblingData) &&
                        typeof siblingData.hourlyRateScaled === 'number' &&
                        typeof siblingData.currency === 'string'
                          ? formatScaledAmount(siblingData.hourlyRateScaled, siblingData.currency)
                          : 'Rate unavailable',
                    ],
                  },
                },
                {
                  name: 'billableByDefault',
                  type: 'checkbox',
                  defaultValue: true,
                  admin: {
                    description: 'Applied when a user creates a time entry for this project.',
                    width: '25%',
                  },
                },
              ],
            },
            {
              name: 'lineDescriptionPrefix',
              type: 'text',
              maxLength: 200,
              admin: {
                description:
                  'Optional project-specific text available to the invoice preview formatter.',
              },
              hooks: {
                beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim() : value)],
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'revenueAccountCode',
                  type: 'text',
                  maxLength: 20,
                  access: { read: financialField },
                  admin: {
                    description: 'Optional override; otherwise customer then Billing Settings.',
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
                  name: 'taxType',
                  type: 'text',
                  maxLength: 50,
                  access: { read: financialField },
                  admin: {
                    description: 'Optional Xero TaxType override.',
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
              name: 'trackingCategories',
              type: 'json',
              access: { read: financialField },
              admin: {
                description:
                  'Optional Xero tracking category/option pairs. Empty values inherit future defaults.',
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'confirmUnbilledImpact',
                  type: 'checkbox',
                  virtual: true,
                  admin: {
                    description:
                      'Required for a rate/currency/account/tax/tracking change when unbilled entries exist. Existing snapshots remain unchanged.',
                    width: '33%',
                  },
                },
                {
                  name: 'commercialChangeReason',
                  type: 'text',
                  virtual: true,
                  maxLength: 1_000,
                  admin: {
                    description: 'Recorded in the audit trail for a confirmed commercial change.',
                    width: '67%',
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    ...attributionFields,
  ],
  hooks: {
    afterChange: [
      auditCollectionChange('project.changed', [
        'billableByDefault',
        'code',
        'currency',
        'customer',
        'hourlyRateScaled',
        'name',
        'revenueAccountCode',
        'status',
        'taxType',
        'trackingCategories',
      ]),
    ],
    beforeChange: [protectCommercialChanges, attributeChange],
    beforeValidate: [validateCustomerCurrency],
  },
  indexes: [{ fields: ['customer', 'status'] }, { fields: ['status', 'name'] }],
  timestamps: true,
  versions: {
    drafts: false,
    maxPerDoc: 50,
  },
}
