import { expect, test } from '@playwright/test'

import {
  cleanupExportDetailFixture,
  type ExportDetailFixture,
  type ExportDetailFixtureRecord,
  seedExportDetailFixture,
} from '../helpers/seedExportDetail'
import { billerAppUser, resetE2ERateLimits, testUser } from '../helpers/seedUser'

import type { Page } from '@playwright/test'

type ExportDetailUser = Pick<typeof testUser, 'email' | 'password' | 'role'> | typeof billerAppUser

const signIn = async (page: Page, user: ExportDetailUser): Promise<void> => {
  await page.goto('/login')
  await page.getByLabel('Email address').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(user.role === 'biller' ? /\/app\/billing$/ : /\/app$/)
}

const openExport = async (page: Page, record: ExportDetailFixtureRecord): Promise<void> => {
  await page.goto(`/app/billing/exports/${record.id}`)
  await expect(page.getByRole('heading', { name: record.reference, exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Mapped invoice lines' })).toBeVisible()
  await expect(page.getByText(record.lineDescription, { exact: true })).toBeVisible()
}

const sectionWithHeading = (page: Page, name: string) =>
  page.locator('section').filter({
    has: page.getByRole('heading', { name, exact: true }),
  })

test.describe.serial('Invoice export detail recovery controls', () => {
  test.setTimeout(90_000)

  let fixture: ExportDetailFixture

  test.beforeAll(async () => {
    fixture = await seedExportDetailFixture()
  })

  test.afterAll(async () => {
    await cleanupExportDetailFixture()
  })

  test.beforeEach(async () => {
    await resetE2ERateLimits()
  })

  test('lets an owner delete a verified succeeded Xero draft', async ({ page }) => {
    await signIn(page, testUser)
    await openExport(page, fixture.succeeded)

    const draftRecovery = sectionWithHeading(page, 'Delete Xero draft and release time')
    await expect(draftRecovery).toBeVisible()
    await expect(
      draftRecovery.getByRole('button', { name: 'Delete Xero draft and release time' }),
    ).toBeVisible()
    await expect(
      draftRecovery.getByRole('button', { name: 'Delete Xero draft and release time' }),
    ).toBeEnabled()
  })

  test('guides an owner through manual review without accepting an entered InvoiceID', async ({
    page,
  }) => {
    await signIn(page, testUser)
    await openExport(page, fixture.manualReview)

    const draftRecovery = sectionWithHeading(page, 'Delete Xero draft and release time')
    await expect(draftRecovery).toBeVisible()
    await expect(draftRecovery).toContainText(/draft deletion is not available/i)
    await expect(
      draftRecovery.getByRole('button', { name: 'Delete Xero draft and release time' }),
    ).toHaveCount(0)
    await expect(draftRecovery.getByRole('link', { name: 'Open draft in Xero' })).toBeVisible()

    const recoveryRequest = sectionWithHeading(page, 'Check Xero and resume export')
    await expect(recoveryRequest).toBeVisible()
    await expect(recoveryRequest.getByRole('button', { name: 'Check Xero again' })).toBeVisible()
    await expect(page.getByLabel('Xero InvoiceID', { exact: true })).toHaveCount(0)
    await expect(
      page.getByRole('heading', { name: 'Accept one verified existing invoice', exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('heading', { name: 'Targeted reconciliation', exact: true }),
    ).toHaveCount(0)
  })

  test('shows reconciliation progress without a duplicate recovery submission', async ({
    page,
  }) => {
    await signIn(page, testUser)
    await openExport(page, fixture.reconciling)

    const progress = sectionWithHeading(page, 'Checking Xero')
    await expect(progress).toBeVisible()
    await expect(progress).toContainText(fixture.reconciling.reference)

    for (const label of [
      'Check Xero again',
      'Check Xero and resume export',
      'Queue reconciliation',
      'Verify and accept invoice',
    ]) {
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0)
    }
  })

  test('lets a biller read export detail without privileged recovery controls', async ({
    page,
  }) => {
    await signIn(page, billerAppUser)
    await openExport(page, fixture.succeeded)

    for (const heading of [
      'Refresh invoice status',
      'Delete Xero draft and release time',
      'Check Xero and resume export',
      'Checking Xero',
      'Create a replacement draft',
      'Release all entries for rebilling',
    ]) {
      await expect(page.getByRole('heading', { name: heading, exact: true })).toHaveCount(0)
    }

    for (const button of [
      'Refresh from Xero',
      'Delete Xero draft and release time',
      'Check Xero again',
      'Create replacement draft',
      'Verify and release all entries',
    ]) {
      await expect(page.getByRole('button', { name: button, exact: true })).toHaveCount(0)
    }
  })
})
