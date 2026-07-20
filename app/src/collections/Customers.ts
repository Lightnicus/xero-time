import { ValidationError } from 'payload'

import {
  adminOnly,
  financialField,
  ownerAdminField,
  readBusinessDirectory,
  systemFieldWrite,
} from '@/access/domain'
import { ownerOrAdmin } from '@/access/roles'
import { auditCollectionChange } from '@/lib/audit/change-hooks'
import {
  DEFAULT_CURRENCY,
  currencyOptions,
  normalizeCurrencyCode,
  validateCurrencyCode,
  validateOptionalXeroID,
  validateWholeNumber,
} from '@/lib/domain/validation'
import { attributeChange, attributionFields } from '@/lib/payload/attribution'

import type {
  CollectionBeforeChangeHook,
  CollectionConfig,
  CollectionSlug,
  PayloadRequest,
} from 'payload'

const USERS_SLUG = 'users' as CollectionSlug
const PROJECTS_SLUG = 'projects' as CollectionSlug
const INVOICE_EXPORTS_SLUG = 'invoice-exports' as CollectionSlug

const invoiceReferenceCodePattern = /^(?=.{1,30}$)[A-Z0-9]+(?:-[A-Z0-9]+)*$/

type CustomerHookDocument = Record<string, unknown> & { id: number | string }

const customerValidationError = (path: string, message: string, req: PayloadRequest): never => {
  throw new ValidationError({
    collection: 'customers',
    errors: [{ message, path }],
    req,
  })
}

export const normalizeInvoiceReferenceCode = (value: unknown): null | string => {
  if (typeof value !== 'string') return null

  const normalized = value.trim().toUpperCase().replace(/\s+/g, '-')
  return normalized || null
}

export const validateInvoiceReferenceCode = (value: unknown): string | true => {
  if (value === null || typeof value === 'undefined' || value === '') return true

  const normalized = normalizeInvoiceReferenceCode(value)
  return (
    (normalized !== null && invoiceReferenceCodePattern.test(normalized)) ||
    'Use 1–30 uppercase letters and numbers, with single hyphens between them.'
  )
}

/** A claimed sequence makes the customer-facing reference identity immutable. */
export const customerHasInvoiceReferenceSequence = async (
  req: PayloadRequest,
  customerID: number | string,
): Promise<boolean> => {
  const exports = await req.payload.find({
    collection: INVOICE_EXPORTS_SLUG,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      and: [{ customer: { equals: customerID } }, { customerReferenceSequence: { exists: true } }],
    },
  })

  return exports.docs.length > 0
}

/** Keep references stable once an export has claimed the customer's sequence. */
export const protectInvoiceReferenceIdentity: CollectionBeforeChangeHook<
  CustomerHookDocument
> = async ({ data, operation, originalDoc, req }) => {
  if (operation === 'create') return data

  const previousCode = normalizeInvoiceReferenceCode(originalDoc?.invoiceReferenceCode)
  const nextCode = normalizeInvoiceReferenceCode(
    Object.hasOwn(data, 'invoiceReferenceCode')
      ? data.invoiceReferenceCode
      : originalDoc?.invoiceReferenceCode,
  )
  const previousStart =
    typeof originalDoc?.invoiceReferenceStartNumber === 'number'
      ? originalDoc.invoiceReferenceStartNumber
      : 1
  const nextStart = Object.hasOwn(data, 'invoiceReferenceStartNumber')
    ? data.invoiceReferenceStartNumber
    : previousStart

  if (previousCode === nextCode && previousStart === nextStart) return data

  const customerID = originalDoc?.id
  if (typeof customerID !== 'string' && typeof customerID !== 'number') {
    return customerValidationError(
      'invoiceReferenceCode',
      'The existing customer could not be identified.',
      req,
    )
  }

  if (
    typeof originalDoc?.lastInvoiceReferenceSequence === 'number' ||
    (await customerHasInvoiceReferenceSequence(req, customerID))
  ) {
    return customerValidationError(
      'invoiceReferenceCode',
      'Invoice reference code and starting number cannot change after this customer has reserved its first invoice reference.',
      req,
    )
  }

  return data
}

/** Existing projects form a currency boundary; use a new customer to change currencies. */
const protectProjectCurrencyBoundary: CollectionBeforeChangeHook<CustomerHookDocument> = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation === 'create' || !Object.hasOwn(data, 'currency')) return data

  const currentCurrency = normalizeCurrencyCode(originalDoc?.currency)
  const nextCurrency = normalizeCurrencyCode(data.currency)
  if (currentCurrency === nextCurrency) return data

  const customerID = originalDoc?.id
  if (typeof customerID !== 'string' && typeof customerID !== 'number') {
    return customerValidationError(
      'currency',
      'The existing customer could not be identified.',
      req,
    )
  }

  const projects = await req.payload.find({
    collection: PROJECTS_SLUG,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      customer: {
        equals: customerID,
      },
    },
  })

  if (projects.docs.length > 0) {
    return customerValidationError(
      'currency',
      'Currency cannot change after projects exist. Archive this customer and create a new currency-specific customer instead.',
      req,
    )
  }

  return data
}

export const Customers: CollectionConfig = {
  slug: 'customers' as CollectionSlug,
  labels: {
    plural: 'Customers',
    singular: 'Customer',
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
    defaultColumns: [
      'name',
      'invoiceReferenceCode',
      'status',
      'currency',
      'xeroMappingStatus',
      'updatedAt',
    ],
    description:
      'Local customers may be used for projects and time before they are explicitly mapped to a Xero contact.',
    group: 'Customers',
    listSearchableFields: ['name', 'billingEmail', 'xeroContactNameSnapshot'],
    useAsTitle: 'name',
  },
  defaultSort: 'name',
  disableBulkDelete: true,
  disableDuplicate: true,
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Customer',
          fields: [
            {
              name: 'name',
              type: 'text',
              required: true,
              index: true,
              maxLength: 200,
              admin: {
                description: 'Local display name. It does not need to match the Xero contact name.',
              },
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
                      'Archived customers remain available to historical time and invoice records.',
                    width: '33%',
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
                  hooks: {
                    beforeValidate: [({ value }) => normalizeCurrencyCode(value)],
                  },
                  admin: {
                    description: 'Projects for this customer must use the same ISO currency.',
                    width: '33%',
                  },
                },
                {
                  name: 'billingEmail',
                  type: 'email',
                  access: {
                    read: financialField,
                  },
                  admin: {
                    description:
                      'Optional local billing contact; Xero remains authoritative for invoices.',
                    width: '34%',
                  },
                },
              ],
            },
            {
              name: 'notes',
              type: 'textarea',
              maxLength: 5_000,
              access: {
                read: financialField,
              },
              admin: {
                description:
                  'Internal notes. These are never copied to a Xero invoice automatically.',
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
                    description: 'Optional billing override inherited by customer projects.',
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
                    description: 'Optional Xero TaxType inherited by customer projects.',
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
              type: 'row',
              fields: [
                {
                  name: 'invoiceReferenceCode',
                  type: 'text',
                  maxLength: 30,
                  validate: validateInvoiceReferenceCode,
                  access: {
                    create: systemFieldWrite,
                    read: financialField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    description:
                      'Stable customer code used in Xero references, for example CUSTOMER-0001. It cannot change after the first reference is reserved.',
                    placeholder: 'CUSTOMER',
                    readOnly: true,
                    width: '50%',
                  },
                  hooks: {
                    beforeValidate: [({ value }) => normalizeInvoiceReferenceCode(value)],
                  },
                },
                {
                  name: 'invoiceReferenceStartNumber',
                  type: 'number',
                  defaultValue: 1,
                  min: 1,
                  validate: (value: unknown) =>
                    value === null || typeof value === 'undefined'
                      ? true
                      : validateWholeNumber(value, { max: Number.MAX_SAFE_INTEGER, min: 1 }),
                  access: {
                    create: systemFieldWrite,
                    read: financialField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    description:
                      'First number allocated for this customer. It cannot change after the first reference is reserved.',
                    readOnly: true,
                    step: 1,
                    width: '50%',
                  },
                },
              ],
            },
            {
              name: 'lastInvoiceReferenceSequence',
              type: 'number',
              min: 1,
              validate: (value: unknown) =>
                value === null || typeof value === 'undefined'
                  ? true
                  : validateWholeNumber(value, { max: Number.MAX_SAFE_INTEGER, min: 1 }),
              access: {
                create: systemFieldWrite,
                read: ownerAdminField,
                update: systemFieldWrite,
              },
              admin: {
                description:
                  'Last customer invoice-reference sequence allocated by the export transaction.',
                hidden: true,
                readOnly: true,
              },
            },
          ],
        },
        {
          label: 'Xero contact mapping',
          fields: [
            {
              name: 'xeroContactId',
              type: 'text',
              unique: true,
              index: true,
              validate: validateOptionalXeroID,
              access: {
                create: systemFieldWrite,
                read: ownerAdminField,
                update: systemFieldWrite,
              },
              admin: {
                description:
                  'Set only by the protected “Select from Xero” or “Create in Xero” workflow; never matched by name.',
                readOnly: true,
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'xeroMappingStatus',
                  type: 'select',
                  required: true,
                  defaultValue: 'unmapped',
                  index: true,
                  options: [
                    { label: 'Unmapped', value: 'unmapped' },
                    { label: 'Active', value: 'active' },
                    { label: 'Archived in Xero', value: 'archived' },
                    { label: 'Invalid', value: 'invalid' },
                    { label: 'Needs review', value: 'needs-review' },
                  ],
                  access: {
                    create: systemFieldWrite,
                    read: ownerAdminField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    description: 'Last known validation state of the explicit ContactID mapping.',
                    readOnly: true,
                    width: '50%',
                  },
                },
                {
                  name: 'xeroContactNameSnapshot',
                  type: 'text',
                  maxLength: 255,
                  access: {
                    create: systemFieldWrite,
                    read: ownerAdminField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    description: 'Display snapshot only; never used as the durable mapping key.',
                    readOnly: true,
                    width: '50%',
                  },
                },
              ],
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'xeroContactEmailSnapshot',
                  type: 'email',
                  access: {
                    create: systemFieldWrite,
                    read: ownerAdminField,
                    update: systemFieldWrite,
                  },
                  admin: { readOnly: true, width: '50%' },
                },
                {
                  name: 'xeroLastValidatedAt',
                  type: 'date',
                  access: {
                    create: systemFieldWrite,
                    read: ownerAdminField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    date: { pickerAppearance: 'dayAndTime' },
                    readOnly: true,
                    width: '50%',
                  },
                },
              ],
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'xeroLinkedAt',
                  type: 'date',
                  access: {
                    create: systemFieldWrite,
                    read: ownerAdminField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    date: { pickerAppearance: 'dayAndTime' },
                    readOnly: true,
                    width: '50%',
                  },
                },
                {
                  name: 'xeroLinkedBy',
                  type: 'relationship',
                  relationTo: USERS_SLUG,
                  maxDepth: 0,
                  access: {
                    create: systemFieldWrite,
                    read: ownerAdminField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    allowCreate: false,
                    allowEdit: false,
                    readOnly: true,
                    width: '50%',
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
      auditCollectionChange('customer.changed', [
        'billingEmail',
        'currency',
        'invoiceReferenceCode',
        'invoiceReferenceStartNumber',
        'lastInvoiceReferenceSequence',
        'name',
        'revenueAccountCode',
        'status',
        'taxType',
      ]),
    ],
    beforeChange: [
      protectProjectCurrencyBoundary,
      protectInvoiceReferenceIdentity,
      attributeChange,
    ],
  },
  indexes: [{ fields: ['status', 'name'] }, { fields: ['currency', 'status'] }],
  timestamps: true,
  versions: {
    drafts: false,
    maxPerDoc: 50,
  },
}
