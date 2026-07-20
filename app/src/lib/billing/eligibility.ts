import 'server-only'

import { hasActiveRole } from '@/access/roles'
import { isRecord, isValidCurrencyCode, relationshipID } from '@/lib/domain/validation'
import type { AppSession } from '@/lib/member-app/session'

import { durationToQuantityScaled, quantityRateAmountScaled } from './math'
import { xeroConnectionBlockers } from './remediation'
import { normalizeBillingFilter } from './selection'

import type {
  BillingBlocker,
  BillingBlockerCode,
  BillingEligibilityResult,
  BillingEntryBase,
  BillingFilter,
  BillingSettingsSnapshot,
  BillingTrackingItem,
  EligibleBillingEntry,
} from './contracts'
import type { Where } from 'payload'

const MAX_QUEUE_ENTRIES = 20_000
const CONTACT_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1_000
const CUSTOMER_REFERENCE_CODE = /^(?=.{1,30}$)[A-Z0-9]+(?:-[A-Z0-9]+)*$/

const relation = (value: unknown): string | null => {
  const id = relationshipID(value)
  return id === null ? null : String(id)
}

const stringValue = (value: unknown, max = 2_000): string =>
  typeof value === 'string' && value.length <= max ? value : ''

const blocker = (
  code: BillingBlockerCode,
  message: string,
  remediationHref?: string,
): BillingBlocker => ({ code, message, remediationHref })

const assertBillingRole = (session: AppSession): void => {
  if (!hasActiveRole(session.user, ['owner', 'admin', 'biller'])) {
    throw new Error('You do not have access to billing.')
  }
}

const chunks = <T>(values: T[], size: number): T[][] => {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

const relatedDocuments = async (
  session: AppSession,
  collection: 'customers' | 'projects' | 'users',
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> => {
  const result = new Map<string, Record<string, unknown>>()
  for (const idChunk of chunks([...new Set(ids)], 200)) {
    if (idChunk.length === 0) continue
    const response = await session.payload.find({
      collection,
      depth: 0,
      limit: idChunk.length,
      overrideAccess: true,
      pagination: false,
      req: session.req,
      where: { id: { in: idChunk } },
    })
    for (const document of response.docs) {
      result.set(String(document.id), document as unknown as Record<string, unknown>)
    }
  }
  return result
}

const baseWhere = (filter: BillingFilter, entryIDs?: string[]): Where => {
  const and: Where[] = []
  if (entryIDs) {
    and.push({ id: { in: entryIDs } })
  } else {
    and.push({ billable: { equals: true } })
    and.push({ billingStatus: { in: ['unbilled', 'reserved'] } })
  }
  if (filter.customerID) and.push({ customer: { equals: filter.customerID } })
  if (filter.projectID) and.push({ project: { equals: filter.projectID } })
  if (filter.userID) and.push({ owner: { equals: filter.userID } })
  if (filter.dateFrom) and.push({ workDate: { greater_than_equal: filter.dateFrom } })
  if (filter.dateTo) and.push({ workDate: { less_than_equal: filter.dateTo } })
  if (filter.currency) and.push({ currencySnapshot: { equals: filter.currency } })
  return and.length === 1 ? (and[0] as Where) : { and }
}

const findEntries = async (
  session: AppSession,
  filter: BillingFilter,
  entryIDs?: string[],
): Promise<Record<string, unknown>[]> => {
  const result = await session.payload.find({
    collection: 'time-entries',
    depth: 0,
    limit: MAX_QUEUE_ENTRIES + 1,
    overrideAccess: true,
    pagination: false,
    req: session.req,
    where: baseWhere(filter, entryIDs),
  })
  const docs = result.docs as unknown as Record<string, unknown>[]
  if (docs.length > MAX_QUEUE_ENTRIES) {
    throw new Error(
      `The billing query exceeds ${MAX_QUEUE_ENTRIES.toLocaleString('en-NZ')} entries. Narrow the date or customer filter.`,
    )
  }
  return docs
}

const trackingItems = (value: unknown): BillingTrackingItem[] | null => {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 2) return null
  const parsed: BillingTrackingItem[] = []
  for (const item of value) {
    if (!isRecord(item)) return null
    const name = stringValue(item.name ?? item.Name, 255).trim()
    const option = stringValue(item.option ?? item.Option, 255).trim()
    if (!name || !option) return null
    parsed.push({
      name,
      option,
      trackingCategoryID:
        stringValue(item.trackingCategoryID ?? item.TrackingCategoryID, 100) || undefined,
      trackingOptionID:
        stringValue(item.trackingOptionID ?? item.TrackingOptionID, 100) || undefined,
    })
  }
  return parsed
}

const requiredTrackingNames = (value: unknown): string[] | null => {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 2) return null
  if (value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 255))
    return null
  return [...new Set((value as string[]).map((item) => item.trim()))]
}

export function billingSettingsSnapshot(value: Record<string, unknown>): BillingSettingsSnapshot {
  const paymentTerms = isRecord(value.paymentTerms) ? value.paymentTerms : {}
  const lineAmountType =
    value.lineAmountType === 'Inclusive' || value.lineAmountType === 'NoTax'
      ? value.lineAmountType
      : 'Exclusive'
  return {
    defaultRevenueAccountCode: stringValue(value.defaultRevenueAccountCode, 20)
      .trim()
      .toUpperCase(),
    defaultTaxType: stringValue(value.defaultTaxType, 50).trim().toUpperCase(),
    invoiceLineDescriptionTemplate:
      stringValue(value.invoiceLineDescriptionTemplate, 1_000) ||
      '{{workDate}} · {{projectCode}} · {{description}}',
    lineAmountType,
    paymentTerms: {
      basis:
        paymentTerms.basis === 'day-of-following-month'
          ? 'day-of-following-month'
          : 'days-after-invoice',
      value:
        typeof paymentTerms.value === 'number' && Number.isSafeInteger(paymentTerms.value)
          ? paymentTerms.value
          : 14,
    },
  }
}

type ReferenceMaps = {
  accounts: Map<string, Record<string, unknown>>
  capabilityAvailable: boolean
  currencies: Set<string>
  taxes: Map<string, Record<string, unknown>>
  tracking: Map<string, Record<string, unknown>>
}

const referenceMaps = async (
  session: AppSession,
  tenantID: string | null,
): Promise<ReferenceMaps> => {
  const maps: ReferenceMaps = {
    accounts: new Map(),
    capabilityAvailable: false,
    currencies: new Set(),
    taxes: new Map(),
    tracking: new Map(),
  }
  if (!tenantID) return maps
  const result = await session.payload.find({
    collection: 'xero-reference-data',
    depth: 0,
    limit: 1_000,
    overrideAccess: true,
    pagination: false,
    req: session.req,
    where: { sourceTenantId: { equals: tenantID } },
  })
  for (const item of result.docs as unknown as Record<string, unknown>[]) {
    if (item.status !== 'active') continue
    const code = stringValue(item.code, 255)
    if (item.resourceType === 'account' && code) maps.accounts.set(code, item)
    if (item.resourceType === 'tax-rate' && code) maps.taxes.set(code, item)
    if (item.resourceType === 'currency' && code) maps.currencies.add(code)
    if (item.resourceType === 'tracking-category')
      maps.tracking.set(stringValue(item.name, 255), item)
    if (item.resourceType === 'organisation-action' && code === 'CreateDraftInvoice') {
      maps.capabilityAvailable = true
    }
  }
  return maps
}

const trackingIsValid = (
  items: BillingTrackingItem[],
  requiredNames: string[],
  references: ReferenceMaps,
): boolean => {
  if (requiredNames.some((name) => !items.some((item) => item.name === name))) return false
  return items.every((item) => {
    const category = references.tracking.get(item.name)
    if (!category || !isRecord(category.metadata) || !Array.isArray(category.metadata.options))
      return false
    return category.metadata.options.some(
      (option) => isRecord(option) && option.name === item.option && option.status === 'active',
    )
  })
}

const taxPercent = (reference: Record<string, unknown> | undefined): number => {
  if (!reference || !isRecord(reference.metadata)) return 0
  const value = reference.metadata.effectiveRate ?? reference.metadata.displayTaxRate
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

const sortEntries = <T extends BillingEntryBase & { currency?: string }>(
  left: T,
  right: T,
): number =>
  left.customerName.localeCompare(right.customerName) ||
  String(left.currency ?? '').localeCompare(String(right.currency ?? '')) ||
  left.workDate.localeCompare(right.workDate) ||
  left.projectCode.localeCompare(right.projectCode) ||
  left.userName.localeCompare(right.userName) ||
  left.entryID.localeCompare(right.entryID)

export async function getBillingEligibility(
  session: AppSession,
  filterInput: Partial<BillingFilter> = {},
  options: { entryIDs?: string[] } = {},
): Promise<
  BillingEligibilityResult & {
    settings: BillingSettingsSnapshot
    settingsDocument: Record<string, unknown>
  }
> {
  assertBillingRole(session)
  const filter = normalizeBillingFilter(filterInput)
  const entries = await findEntries(session, filter, options.entryIDs)
  const customerIDs = entries.map((entry) => relation(entry.customer)).filter(Boolean) as string[]
  const projectIDs = entries.map((entry) => relation(entry.project)).filter(Boolean) as string[]
  const userIDs = entries.map((entry) => relation(entry.owner)).filter(Boolean) as string[]
  // The MongoDB driver does not support parallel operations on one transaction
  // session. Eligibility is also evaluated while reserving an export, so keep
  // these reads sequential even though standalone previews could parallelise.
  const customers = await relatedDocuments(session, 'customers', customerIDs)
  const projects = await relatedDocuments(session, 'projects', projectIDs)
  const users = await relatedDocuments(session, 'users', userIDs)
  const settingsDocument = await session.payload.findGlobal({
    slug: 'billing-settings',
    depth: 0,
    overrideAccess: true,
    req: session.req,
  })
  const connectionResult = await session.payload.find({
    collection: 'xero-connections',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req: session.req,
    where: { singletonKey: { equals: 'business-accounting' } },
  })
  const connection = connectionResult.docs[0] as unknown as Record<string, unknown> | undefined
  const tenantID = connection?.status === 'connected' ? stringValue(connection.tenantId, 100) : ''
  const references = await referenceMaps(session, tenantID || null)
  const settingsRecord = settingsDocument as unknown as Record<string, unknown>
  const settings = billingSettingsSnapshot(settingsRecord)
  const defaultTracking = trackingItems(settingsRecord.defaultTrackingCategories)
  const requiredTracking = requiredTrackingNames(settingsRecord.requiredTrackingCategoryNames)

  const eligible: EligibleBillingEntry[] = []
  const blocked: BillingEligibilityResult['blocked'] = []

  for (const entry of entries) {
    const entryID = String(entry.id)
    const customerID = relation(entry.customer) ?? ''
    const projectID = relation(entry.project) ?? ''
    const userID = relation(entry.owner) ?? ''
    const customer = customers.get(customerID)
    const project = projects.get(projectID)
    const user = users.get(userID)
    const durationSeconds = Number(entry.durationSeconds)
    const rateScaled = Number(entry.rateSnapshotScaled)
    const currency = stringValue(entry.currencySnapshot, 3).toUpperCase()
    const base: BillingEntryBase = {
      amountScaled: 0,
      customerID,
      customerName:
        stringValue(entry.customerNameSnapshot, 200) ||
        stringValue(customer?.name, 200) ||
        'Unknown customer',
      description: stringValue(entry.description),
      durationSeconds: Number.isSafeInteger(durationSeconds) ? durationSeconds : 0,
      entryID,
      projectCode:
        stringValue(entry.projectCodeSnapshot, 40) || stringValue(project?.code, 40) || 'UNKNOWN',
      projectID,
      projectName:
        stringValue(entry.projectNameSnapshot, 200) ||
        stringValue(project?.name, 200) ||
        'Unknown project',
      rateScaled: Number.isSafeInteger(rateScaled) ? rateScaled : 0,
      timezone: stringValue(entry.timezone, 100) || filter.timezone,
      updatedAt: stringValue(entry.updatedAt, 100),
      userID,
      userName: stringValue(user?.displayName, 120) || 'Unknown user',
      workDate: stringValue(entry.workDate, 10),
    }
    const reasons: BillingBlocker[] = []
    if (entry.billable !== true)
      reasons.push(blocker('not-billable', 'This entry is not marked billable.'))
    if (entry.billingStatus !== 'unbilled') {
      reasons.push(
        entry.billingStatus === 'reserved' || relation(entry.currentExport)
          ? blocker(
              'active-reservation',
              'This entry is already reserved by another export.',
              relation(entry.currentExport)
                ? `/app/billing/exports/${relation(entry.currentExport)}`
                : undefined,
            )
          : blocker('not-unbilled', 'This entry has already been exported.'),
      )
    }
    if (
      !Number.isSafeInteger(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds % 60 !== 0
    ) {
      reasons.push(
        blocker(
          'invalid-duration',
          'Duration must be a positive whole number of minutes.',
          `/app/time/${entryID}/edit`,
        ),
      )
    }
    if (!Number.isSafeInteger(rateScaled) || rateScaled <= 0) {
      reasons.push(
        blocker(
          'missing-rate',
          'The captured hourly rate is missing or zero.',
          `/admin/collections/projects/${projectID}`,
        ),
      )
    }
    if (!isValidCurrencyCode(currency))
      reasons.push(blocker('invalid-currency', 'The entry has an invalid currency snapshot.'))
    if (!projectID || !project)
      reasons.push(blocker('missing-project', 'The source project no longer exists.'))
    if (!customerID || !customer)
      reasons.push(blocker('missing-customer', 'The source customer no longer exists.'))

    const customerReferenceCode = stringValue(customer?.invoiceReferenceCode, 30)
    const rawReferenceStartNumber = customer?.invoiceReferenceStartNumber
    const customerReferenceStartNumber =
      rawReferenceStartNumber == null ? 1 : Number(rawReferenceStartNumber)
    const rawLastReferenceSequence = customer?.lastInvoiceReferenceSequence
    const customerReferenceLastSequence =
      rawLastReferenceSequence == null ? null : Number(rawLastReferenceSequence)
    const referenceSequenceStateIsValid =
      Number.isSafeInteger(customerReferenceStartNumber) &&
      customerReferenceStartNumber >= 1 &&
      (customerReferenceLastSequence === null ||
        (Number.isSafeInteger(customerReferenceLastSequence) &&
          customerReferenceLastSequence >= 1 &&
          customerReferenceLastSequence >= customerReferenceStartNumber &&
          customerReferenceLastSequence < Number.MAX_SAFE_INTEGER))
    const customerReferenceSequence = referenceSequenceStateIsValid
      ? Math.max(
          customerReferenceStartNumber,
          customerReferenceLastSequence === null ? 1 : customerReferenceLastSequence + 1,
        )
      : 0
    if (
      customer &&
      (!CUSTOMER_REFERENCE_CODE.test(customerReferenceCode) ||
        !referenceSequenceStateIsValid ||
        !Number.isSafeInteger(customerReferenceSequence))
    ) {
      reasons.push(
        blocker(
          'missing-customer-reference',
          'Set a valid invoice reference code and starting number for this customer.',
          `/app/settings/customers#customer-reference-${encodeURIComponent(customerID)}`,
        ),
      )
    }
    if (
      project &&
      customer &&
      (relation(project.customer) !== customerID ||
        project.currency !== currency ||
        customer.currency !== currency)
    ) {
      reasons.push(
        blocker(
          'currency-conflict',
          'The entry, project, and customer currency boundary no longer agrees.',
        ),
      )
    }
    if (!userID || !user)
      reasons.push(blocker('stale-source-data', 'The source user is unavailable.'))

    const contactID = stringValue(customer?.xeroContactId, 100)
    reasons.push(...xeroConnectionBlockers(tenantID || null, references.capabilityAvailable))
    if (!contactID || customer?.xeroMappingStatus === 'unmapped') {
      reasons.push(
        blocker(
          'unmapped-contact',
          'Map this customer to a Xero contact.',
          '/app/settings/customers',
        ),
      )
    } else if (customer?.xeroMappingStatus === 'archived') {
      reasons.push(
        blocker(
          'archived-contact',
          'The mapped Xero contact is archived.',
          '/app/settings/customers',
        ),
      )
    } else if (customer?.xeroMappingStatus !== 'active') {
      reasons.push(
        blocker(
          'stale-source-data',
          'The Xero contact mapping needs review.',
          '/app/settings/customers',
        ),
      )
    }
    const validatedAt = Date.parse(stringValue(customer?.xeroLastValidatedAt, 100))
    if (
      contactID &&
      (!Number.isFinite(validatedAt) || validatedAt < Date.now() - CONTACT_FRESHNESS_MS)
    ) {
      reasons.push(
        blocker(
          'stale-contact',
          'Refresh this Xero contact mapping before invoicing.',
          '/app/settings/customers',
        ),
      )
    }

    const projectAccountCode = stringValue(project?.revenueAccountCode, 20)
    const customerAccountCode = stringValue(customer?.revenueAccountCode, 20)
    const accountCode =
      projectAccountCode || customerAccountCode || settings.defaultRevenueAccountCode
    const accountRemediationHref = projectAccountCode
      ? `/admin/collections/projects/${projectID}`
      : customerAccountCode
        ? `/admin/collections/customers/${customerID}`
        : '/app/settings/billing'
    const projectTaxType = stringValue(project?.taxType, 50)
    const customerTaxType = stringValue(customer?.taxType, 50)
    const taxType = projectTaxType || customerTaxType || settings.defaultTaxType
    const taxRemediationHref = projectTaxType
      ? `/admin/collections/projects/${projectID}`
      : customerTaxType
        ? `/admin/collections/customers/${customerID}`
        : '/app/settings/billing'
    if (!accountCode)
      reasons.push(blocker('missing-account', 'Choose a revenue account.', '/app/settings/billing'))
    else if (tenantID && !references.accounts.has(accountCode))
      reasons.push(
        blocker(
          'invalid-account',
          'The revenue account is not active in the connected Xero organisation.',
          accountRemediationHref,
        ),
      )
    if (!taxType && settings.lineAmountType !== 'NoTax')
      reasons.push(blocker('missing-tax', 'Choose a tax type.', '/app/settings/billing'))
    else if (tenantID && settings.lineAmountType !== 'NoTax' && !references.taxes.has(taxType))
      reasons.push(
        blocker(
          'invalid-tax',
          'The tax type is not active in the connected Xero organisation.',
          taxRemediationHref,
        ),
      )
    if (tenantID && currency && !references.currencies.has(currency))
      reasons.push(
        blocker(
          'unsupported-currency',
          'The currency is not enabled in the connected Xero organisation.',
          '/app/settings/xero',
        ),
      )

    const projectTracking = trackingItems(project?.trackingCategories)
    const tracking =
      projectTracking && projectTracking.length > 0 ? projectTracking : defaultTracking
    if (
      !tracking ||
      !requiredTracking ||
      !trackingIsValid(tracking, requiredTracking, references)
    ) {
      reasons.push(
        blocker(
          'invalid-tracking',
          'Required Xero tracking categories/options are missing or inactive.',
          `/admin/collections/projects/${projectID}`,
        ),
      )
    }

    let amountScaled = 0
    if (
      Number.isSafeInteger(durationSeconds) &&
      durationSeconds > 0 &&
      durationSeconds % 60 === 0 &&
      Number.isSafeInteger(rateScaled) &&
      rateScaled >= 0
    ) {
      amountScaled = quantityRateAmountScaled(durationToQuantityScaled(durationSeconds), rateScaled)
    }
    base.amountScaled = amountScaled

    if (reasons.length > 0) {
      blocked.push({ ...base, blockers: reasons, currency: currency || undefined })
    } else {
      eligible.push({
        ...base,
        accountCode,
        amountScaled,
        contactID,
        contactName: stringValue(customer?.xeroContactNameSnapshot, 255) || base.customerName,
        currency,
        customerReferenceCode,
        customerReferenceLastSequence,
        customerReferenceSequence,
        customerReferenceStartNumber,
        taxRatePercent:
          settings.lineAmountType === 'NoTax' ? 0 : taxPercent(references.taxes.get(taxType)),
        taxType: settings.lineAmountType === 'NoTax' ? taxType || 'NONE' : taxType,
        tracking: tracking ?? [],
      })
    }
  }

  eligible.sort(sortEntries)
  blocked.sort(sortEntries)
  const filteredBlocked = filter.blocker
    ? blocked.filter((entry) => entry.blockers.some((item) => item.code === filter.blocker))
    : blocked
  return {
    blocked: filteredBlocked,
    eligible: filter.blocker ? [] : eligible,
    generatedAt: new Date().toISOString(),
    settings,
    settingsDocument: settingsRecord,
  }
}
