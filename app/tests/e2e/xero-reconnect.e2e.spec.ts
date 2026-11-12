import { expect, test } from '@playwright/test'

import { resetE2ERateLimits, testUser } from '../helpers/seedUser'
import {
  cleanupXeroReconnectFixture,
  RECONNECT_TENANT_NAME,
  seedXeroReconnectFixture,
} from '../helpers/seedXeroReconnect'

import type { Page } from '@playwright/test'

const signIn = async (page: Page) => {
  await page.goto('/login')
  await page.getByLabel('Email address').fill(testUser.email)
  await page.getByLabel('Password').fill(testUser.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/app$/)
}

test.describe.serial('Xero reconnection guidance', () => {
  test.beforeAll(async () => {
    await seedXeroReconnectFixture()
  })

  test.beforeEach(async () => {
    await resetE2ERateLimits()
  })

  test.afterAll(async () => {
    await cleanupXeroReconnectFixture()
  })

  test('guides the user from the app-wide banner to a reconnect', async ({ page }) => {
    await signIn(page)

    const banner = page.getByRole('alert').filter({ hasText: 'needs to be reconnected' })
    await expect(banner).toContainText(`Xero (${RECONNECT_TENANT_NAME}) needs to be reconnected.`)
    await banner.getByRole('link', { name: 'Reconnect Xero' }).click()
    await expect(page).toHaveURL(/\/app\/settings\/xero$/)

    await expect(
      page.getByRole('heading', { name: 'Xero stopped working: reconnect to resume invoicing' }),
    ).toBeVisible()
    await expect(
      page.getByText('Xero no longer accepts the saved authorization.').first(),
    ).toBeVisible()
    const recoverySteps = page.locator('.recovery-steps')
    await expect(recoverySteps).toContainText(`create invoices in ${RECONNECT_TENANT_NAME}`)
    await expect(recoverySteps).toContainText('Invoice exports work again')
    await expect(page.getByRole('button', { name: 'Reconnect Xero' })).toBeVisible()

    await expect(page.getByText('Reconnecting as a different Xero user?')).toHaveCount(0)
    await expect(page.getByLabel(/password/i)).toHaveCount(0)
  })
})
