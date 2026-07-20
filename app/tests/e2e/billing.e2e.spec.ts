import { expect, test } from '@playwright/test'

import { cleanupTestUser, seedBillingAppFixture, testUser } from '../helpers/seedUser'

const signIn = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.goto('/login')
  await page.getByLabel('Email address').fill(testUser.email)
  await page.getByLabel('Password').fill(testUser.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/app$/)
}

const reserveCurrentPreview = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.getByRole('checkbox', { name: /I reviewed every invoice header/ }).check()
  await page.getByRole('button', { name: 'Reserve and export' }).click()
  await expect(page).toHaveURL(/\/app\/billing\/exports\?batch=.*status=created/)
  await expect(page.getByRole('status')).toContainText('created')
}

const openAndCancelOnlyExport = async (page: import('@playwright/test').Page): Promise<void> => {
  const exportRow = page.locator('tbody tr').first()
  await exportRow.getByRole('link').first().click()
  await expect(page.getByRole('heading', { name: /^E2E-/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Mapped invoice lines' })).toBeVisible()
  await page.getByLabel('Reason').fill('Cancelled safely by the billing browser test.')
  await page.getByRole('button', { name: 'Cancel export' }).click()
  await expect(page).toHaveURL(/status=cancelled/)
  await expect(page.getByRole('status')).toContainText('cancelled')
}

test.describe.serial('Billing application', () => {
  test.setTimeout(90_000)

  test.beforeAll(async () => {
    await seedBillingAppFixture()
  })

  test.afterAll(async () => {
    await cleanupTestUser()
  })

  test('sets Xero invoice defaults in the frontend', async ({ page }) => {
    await signIn(page)
    await page.goto('/app/settings/billing')

    await expect(page.getByRole('heading', { name: 'Invoice defaults' })).toBeVisible()
    await expect(page.getByLabel('Revenue account')).toHaveValue('200')
    await expect(page.getByLabel('Tax type')).toHaveValue('OUTPUT2')
    await expect(page.getByRole('option', { name: '200 — Sales' })).toBeAttached()
    await expect(page.getByRole('option', { name: 'GST on Income — OUTPUT2 (15%)' })).toBeAttached()

    await page.getByRole('button', { name: 'Save invoice defaults' }).click()

    await expect(page).toHaveURL(/\/app\/settings\/billing\?saved=1$/)
    await expect(page.getByRole('status')).toContainText('Invoice defaults saved.')
  })

  test('previews and confirms a reasoned recalculation of unbilled project rates', async ({
    page,
  }) => {
    await signIn(page)
    await page.goto('/app/settings/projects')

    const projectRow = page.getByRole('row').filter({ hasText: 'E2E-BILL' })
    await expect(projectRow).toContainText('NZD 200.00')
    await projectRow.getByRole('link', { name: 'Preview recalculation' }).click()
    await expect(
      page.getByRole('heading', { name: 'E2E-BILL — Browser Billing Project' }),
    ).toBeVisible()
    await expect(page.getByText('2 unbilled entries have a different snapshot rate.')).toBeVisible()

    await page.getByLabel('Commercial reason').fill('Apply the approved browser-test project rate.')
    await page.getByLabel('Type RECALCULATE').fill('RECALCULATE')
    await page.getByRole('button', { name: 'Recalculate unbilled snapshots' }).click()

    await expect(page).toHaveURL(/updated=2/)
    await expect(page.getByRole('status')).toContainText('Updated 2 unbilled time entries.')
  })

  test('previews, reserves, and safely cancels selected and all-matching exports', async ({
    page,
  }) => {
    await signIn(page)
    await page.goto('/app/billing')

    await expect(page.getByRole('heading', { name: 'Billing queue' })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /^Select Billing/ })).toHaveCount(2)
    const selectionSummary = page.locator('.selection-summary-grid')
    await expect(selectionSummary).toContainText('Selected preview2 entries · 2h 0m')
    await page.getByRole('button', { name: 'Clear visible' }).click()
    await expect(selectionSummary).toContainText('Selected preview0 entries · 0h 0m')
    await expect(selectionSummary).toContainText('All matching preview0 entries · 0h 0m')
    await page.getByRole('button', { name: 'Select visible' }).click()
    await page.getByRole('checkbox', { name: 'Select Billing implementation review' }).uncheck()
    await expect(selectionSummary).toContainText('Selected preview1 entries · 1h 15m')
    await expect(selectionSummary).toContainText('All matching preview1 entries · 1h 15m')
    await page.getByRole('button', { name: 'Preview selected' }).click()

    await expect(page.getByRole('heading', { name: 'Review 1 Xero invoice' })).toBeVisible()
    await expect(page.getByText('2026-07-18 · E2E-BILL · Billing discovery workshop')).toBeVisible()
    await expect(page.getByText('Billing implementation review')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Preview summary' })).toContainText('1h 15m')

    await reserveCurrentPreview(page)
    await openAndCancelOnlyExport(page)

    await page.goto('/app/billing')
    await expect(page.getByRole('checkbox', { name: /^Select Billing/ })).toHaveCount(2)
    await page.getByRole('button', { name: 'Preview all matching' }).click()

    await expect(page.getByRole('heading', { name: 'Review 1 Xero invoice' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Preview summary' })).toContainText('2h 0m')
    await expect(page.getByText('2026-07-18 · E2E-BILL · Billing discovery workshop')).toBeVisible()
    await expect(
      page.getByText('2026-07-18 · E2E-BILL · Billing implementation review'),
    ).toBeVisible()

    await reserveCurrentPreview(page)
    await openAndCancelOnlyExport(page)

    await page.goto('/app/billing')
    await expect(page.getByRole('checkbox', { name: /^Select Billing/ })).toHaveCount(2)
  })
})
