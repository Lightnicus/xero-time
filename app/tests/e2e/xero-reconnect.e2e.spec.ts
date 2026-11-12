import { expect, test } from '@playwright/test'

import { billerAppUser, resetE2ERateLimits, testUser } from '../helpers/seedUser'
import {
  cleanupXeroReconnectFixture,
  RECONNECT_TENANT_NAME,
  seedXeroReconnectFixture,
} from '../helpers/seedXeroReconnect'

import type { Page } from '@playwright/test'

const signIn = async (page: Page, user: { email: string; password: string }) => {
  await page.goto('/login')
  await page.getByLabel('Email address').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/app/)
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

  test('guides an owner from the app-wide banner to a reconnect', async ({ page }) => {
    await signIn(page, testUser)

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
    await expect(page.getByRole('button', { name: 'Reconnect Xero' })).toBeVisible()

    await page.getByText('Reconnecting as a different Xero user?').click()
    await expect(page.getByLabel('I am reconnecting as a different Xero user')).toBeVisible()
    await expect(page.getByLabel('Reason for changing the Xero user')).toBeVisible()
  })

  test('tells a biller who to ask instead of offering the reconnect', async ({ page }) => {
    await signIn(page, billerAppUser)

    const banner = page.getByRole('alert').filter({ hasText: 'needs to be reconnected' })
    await expect(banner).toContainText('Ask an owner or admin to reconnect Xero')
    await expect(banner.getByRole('link', { name: 'Reconnect Xero' })).toHaveCount(0)
  })
})
