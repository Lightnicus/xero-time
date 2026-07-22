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
  await page.getByRole('button', { name: 'Create draft invoices' }).click()
  await expect(page).toHaveURL(/\/app\/billing\/exports\?batch=.*status=created/)
  await expect(page.getByRole('status')).toContainText('created')
}

const openAndCancelOnlyExport = async (
  page: import('@playwright/test').Page,
  expectedReference: string,
): Promise<void> => {
  const exportRow = page.locator('tbody tr').first()
  await exportRow.getByRole('link').first().click()
  await expect(page.getByRole('heading', { name: expectedReference, exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Mapped invoice lines' })).toBeVisible()
  await expect(page.getByText('TIME — Professional services').first()).toBeVisible()
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

    await expect(page.getByRole('heading', { name: 'Invoice defaults', exact: true })).toBeVisible()
    await expect(page.getByLabel('Revenue account')).toHaveValue('200')
    await expect(page.getByLabel('Tax type')).toHaveValue('OUTPUT2')
    await expect(page.getByRole('option', { name: '200 — Sales' })).toBeAttached()
    await expect(page.getByRole('option', { name: 'GST on Income — OUTPUT2 (15%)' })).toBeAttached()

    await page.getByRole('button', { name: 'Save invoice defaults' }).click()

    await expect(page).toHaveURL(/\/app\/settings\/billing\?saved=1$/)
    await expect(page.getByRole('status')).toContainText('Invoice defaults saved.')
  })

  test('shows the customer reference code and next sequence in the frontend', async ({ page }) => {
    await signIn(page)
    await page.goto('/app/settings/customers')

    const customerReference = page
      .locator('[id^="customer-reference-"]')
      .filter({ hasText: 'Billable E2E Customer' })
    await expect(customerReference.getByLabel('Customer reference code')).toHaveValue(
      'E2E-CUSTOMER',
    )
    await expect(customerReference).toContainText('Next reference: E2E-CUSTOMER-0001')
    await customerReference.getByRole('button', { name: 'Save invoice reference' }).click()
    await expect(page).toHaveURL(/reference=saved/)
    await expect(page.getByRole('status')).toContainText('Invoice reference settings saved')
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

    await page
      .locator('#recalculation-preview')
      .getByLabel('Commercial reason')
      .fill('Apply the approved browser-test project rate.')
    await page.getByLabel('Type RECALCULATE').fill('RECALCULATE')
    await page.getByRole('button', { name: 'Recalculate unbilled snapshots' }).click()

    await expect(page).toHaveURL(/updated=2/)
    await expect(page.getByRole('status')).toContainText('Updated 2 unbilled time entries.')
  })

  test('keeps the billing decision operable without horizontal overflow at 390px', async ({
    page,
  }) => {
    await signIn(page)
    await page.setViewportSize({ height: 844, width: 390 })
    await page.goto('/app/billing')

    await expect(page.getByLabel('Invoice date')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Review draft invoices' })).toHaveCount(1)
    await expect(page.getByRole('checkbox', { name: /^Select Billing/ })).toHaveCount(2)
    const pageWidth = await page.locator('html').evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }))
    expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.client)

    const reviewAction = page.getByRole('button', { name: 'Review draft invoices' })
    const reviewActionBox = await reviewAction.boundingBox()
    expect(reviewActionBox).not.toBeNull()
    expect(reviewActionBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(844 * 2)

    const implementationRow = page.getByRole('checkbox', {
      name: 'Select Billing implementation review',
    })
    await implementationRow.uncheck()
    await expect(implementationRow).not.toBeChecked()
    await page.getByRole('radio', { name: /^All matching filters/ }).check()
    await expect(page.locator('.billing-scope-summary')).toContainText('1 entry · 1h 15m')
  })

  test('previews, reserves, and safely cancels every unified billing scope', async ({
    context,
    page,
  }) => {
    await signIn(page)
    await page.goto('/app/billing')

    await expect(page.getByRole('heading', { name: 'Billing queue' })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /^Select Billing/ })).toHaveCount(2)
    await expect(page.getByLabel('Invoice date')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Review draft invoices' })).toHaveCount(1)
    const selectionSummary = page.locator('.billing-scope-summary')
    await expect(selectionSummary).toContainText('2 entries · 2h 0m')
    await page.getByRole('button', { name: 'Clear visible' }).click()
    await expect(selectionSummary).toContainText('0 entries · 0h 0m')
    await expect(page.getByText('Select at least one row to review.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Review draft invoices' })).toBeDisabled()
    await page.getByRole('button', { name: 'Select visible' }).click()
    await page.getByRole('checkbox', { name: 'Select Billing implementation review' }).uncheck()
    await expect(selectionSummary).toContainText('1 entry · 1h 15m')
    await page.getByRole('button', { name: 'Review draft invoices' }).click()

    await expect(page.getByRole('heading', { name: 'Review 1 draft invoice' })).toBeVisible()
    await expect(page.getByText('2026-07-18 · E2E-BILL · Billing discovery workshop')).toBeVisible()
    await expect(page.getByText('Billing implementation review')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Preview summary' })).toContainText('1h 15m')
    await expect(page.getByRole('region', { name: 'Preview values' })).toContainText('NZD 250.00')
    await expect(page.getByText('E2E-CUSTOMER-0001', { exact: true })).toBeVisible()
    await expect(page.getByText('TIME — Professional services')).toBeVisible()

    const unreservedPreviewURL = page.url()
    await page.getByRole('link', { name: 'Cancel preview' }).click()
    await expect(page).toHaveURL(/\/app\/billing$/)
    await expect(page.getByRole('checkbox', { name: /^Select Billing/ })).toHaveCount(2)
    await page.goto(unreservedPreviewURL)
    await expect(page.getByRole('heading', { name: 'Review 1 draft invoice' })).toBeVisible()

    await reserveCurrentPreview(page)
    await openAndCancelOnlyExport(page, 'E2E-CUSTOMER-0001')

    await page.goto('/app/billing')
    await expect(page.getByRole('checkbox', { name: /^Select Billing/ })).toHaveCount(2)
    await page.getByRole('radio', { name: /^All matching filters/ }).check()
    await expect(selectionSummary).toContainText('2 entries · 2h 0m')
    await page.getByRole('checkbox', { name: 'Select Billing implementation review' }).uncheck()
    await expect(selectionSummary).toContainText('1 entry · 1h 15m')
    await page.getByRole('button', { name: 'Review draft invoices' }).click()

    await expect(page.getByRole('heading', { name: 'Review 1 draft invoice' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Preview summary' })).toContainText('1h 15m')
    await expect(page.getByRole('region', { name: 'Preview values' })).toContainText('NZD 250.00')
    await expect(page.getByText('2026-07-18 · E2E-BILL · Billing discovery workshop')).toBeVisible()
    await expect(page.getByText(/Billing implementation review/)).toHaveCount(0)
    await expect(page.getByText('E2E-CUSTOMER-0002', { exact: true })).toBeVisible()

    await reserveCurrentPreview(page)
    await openAndCancelOnlyExport(page, 'E2E-CUSTOMER-0002')

    await page.goto('/app/billing?dateFrom=2026-07-19')
    await expect(page.getByRole('checkbox', { name: /^Select Billing/ })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Eligible billing summary' })).toContainText(
      '0 entries',
    )
    await page.getByRole('radio', { name: /^All uninvoiced/ }).check()
    await expect(page.locator('.billing-scope-summary')).toContainText('2 entries · 2h 0m')
    await expect(page.getByRole('button', { name: 'Review draft invoices' })).toBeEnabled()
    await page.getByRole('button', { name: 'Review draft invoices' }).click()

    await expect(page.getByRole('heading', { name: 'Review 1 draft invoice' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Preview summary' })).toContainText('2h 0m')
    await expect(page.getByRole('region', { name: 'Preview values' })).toContainText('NZD 400.00')
    await expect(page.getByText('2026-07-18 · E2E-BILL · Billing discovery workshop')).toBeVisible()
    await expect(
      page.getByText('2026-07-18 · E2E-BILL · Billing implementation review'),
    ).toBeVisible()
    await expect(page.getByText('E2E-CUSTOMER-0003', { exact: true })).toBeVisible()

    await reserveCurrentPreview(page)
    await openAndCancelOnlyExport(page, 'E2E-CUSTOMER-0003')

    await page.goto('/app/billing')
    await expect(page.getByRole('checkbox', { name: /^Select Billing/ })).toHaveCount(2)
    await page.getByRole('checkbox', { name: 'Select Billing implementation review' }).uncheck()
    await page.getByRole('button', { name: 'Review draft invoices' }).click()
    await expect(page.getByRole('heading', { name: 'Review 1 draft invoice' })).toBeVisible()

    const sourceHref = await page
      .getByRole('link', { name: '2026-07-18', exact: true })
      .first()
      .getAttribute('href')
    expect(sourceHref).toMatch(/^\/app\/time\/.+\/edit$/)
    const editor = await context.newPage()
    await editor.goto(sourceHref as string)
    await editor
      .getByLabel('Description')
      .fill('Billing discovery workshop revised for stale preview')
    await editor
      .getByRole('textbox', { name: 'Reason', exact: true })
      .fill('Verify stale billing preview rejection safely.')
    await editor.getByRole('button', { name: 'Save changes' }).click()
    await expect(editor).toHaveURL(/\/app\?updated=1$/)
    await editor.close()

    await page.getByRole('checkbox', { name: /I reviewed every invoice header/ }).check()
    await page.getByRole('button', { name: 'Create draft invoices' }).click()
    await expect(page).toHaveURL(/status=stale-or-failed/)
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'previous confirmation was stale',
    )
    await expect(
      page.getByText(
        '2026-07-18 · E2E-BILL · Billing discovery workshop revised for stale preview',
      ),
    ).toBeVisible()
    await page.getByRole('link', { name: 'Cancel preview' }).click()
    await expect(page.getByRole('checkbox', { name: /^Select Billing/ })).toHaveCount(2)
  })
})
