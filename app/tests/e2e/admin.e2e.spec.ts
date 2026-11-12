import { test, expect, Page } from '@playwright/test'

import { login } from '../helpers/login'
import { adminRateProject, cleanupTestUser, seedTestUser, testUser } from '../helpers/seedUser'

test.describe('Admin Panel', () => {
  let page: Page
  const serverURL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3101'

  test.beforeAll(async ({ browser }) => {
    await seedTestUser()

    const context = await browser.newContext()
    page = await context.newPage()

    await login({ page, serverURL, user: testUser })
  })

  test.afterAll(async () => {
    await cleanupTestUser()
  })

  test('can navigate to dashboard', async () => {
    await page.goto(`${serverURL}/admin`)
    await expect(page).toHaveURL(`${serverURL}/admin`)
    const brandedHomeLink = page.getByRole('link', { name: 'Project Time' })
    await expect(brandedHomeLink).toBeVisible()
    await expect(brandedHomeLink).toContainText('PT')
    const dashboardArtifact = page.locator('span[title="Dashboard"]').first()
    await expect(dashboardArtifact).toBeVisible()
  })

  test('exposes only minimal readiness information', async () => {
    const response = await page.request.get(`${serverURL}/api/health`)

    expect(response.status()).toBe(200)
    expect(response.headers()['cache-control']).toContain('no-store')
    expect(await response.json()).toEqual({ ready: true })
  })

  test('can navigate to list view', async () => {
    await page.goto(`${serverURL}/admin/collections/users`)
    await expect(page).toHaveURL(`${serverURL}/admin/collections/users`)
    const listViewArtifact = page.locator('h1', { hasText: 'Users' }).first()
    await expect(listViewArtifact).toBeVisible()
  })

  test('can navigate to edit view', async () => {
    await page.goto(`${serverURL}/admin/collections/users/create`)
    await expect(page).toHaveURL(/\/admin\/collections\/users\/[a-zA-Z0-9-_]+/)
    const editViewArtifact = page.locator('input[name="email"]')
    await expect(editViewArtifact).toBeVisible()
  })

  test('edits and lists hourly rates as ordinary currency values', async () => {
    await page.goto(`${serverURL}/admin/collections/projects`)
    const projectRow = page.locator('tr', { hasText: adminRateProject.name })

    await expect(projectRow).toContainText('NZD 150.00')
    await expect(projectRow).not.toContainText('1500000')
    await projectRow.getByRole('link', { name: adminRateProject.code }).click()
    await expect(page).toHaveURL(/\/admin\/collections\/projects\/[^/]+$/)

    const hourlyRate = page.getByLabel('Hourly rate')
    await expect(hourlyRate).toHaveValue('150.00')
    await expect(page.locator('body')).not.toContainText('Hourly Rate Scaled')
    await expect(page.locator('body')).not.toContainText('10,000 units')

    await hourlyRate.fill('175.12565')
    await page.locator('#action-save').click()
    await expect(
      page.getByText('Enter a non-negative hourly rate with no more than four decimal places.'),
    ).toBeVisible()

    await hourlyRate.fill('175.1256')
    const saveResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && /\/api\/projects\//.test(response.url()),
    )
    await page.locator('#action-save').click()
    const storedProjectResponse = await saveResponse
    expect(storedProjectResponse.ok()).toBe(true)
    expect((await storedProjectResponse.json()).doc.hourlyRateScaled).toBe(1_751_256)

    await page.reload()
    await expect(page.getByLabel('Hourly rate')).toHaveValue('175.1256')

    await page.goto(`${serverURL}/admin/collections/projects`)
    const updatedProjectRow = page.locator('tr', { hasText: adminRateProject.name })
    await expect(updatedProjectRow).toContainText('NZD 175.13')
    await expect(updatedProjectRow).not.toContainText('175.1256')
  })

  test('shows the private Xero accounting setup screen without exposing credentials', async () => {
    await page.goto(`${serverURL}/app/settings/xero`)

    await expect(page.getByRole('heading', { name: 'Xero accounting' })).toBeVisible()
    await expect(page.getByText('Not configured')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Accounting OAuth application' })).toBeVisible()
    await expect(
      page.getByText(`${serverURL}/api/integrations/xero/accounting/callback`),
    ).toBeVisible()
    await expect(page.getByLabel('Xero accounting client ID')).toBeVisible()
    await expect(page.getByLabel('Xero accounting client secret')).toBeVisible()
    await expect(page.getByLabel(/current.*password/i)).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('TOKEN_ENCRYPTION_KEY')
    await expect(page.locator('body')).not.toContainText('XERO_ACCOUNTING_CLIENT_SECRET')
  })
})
