import { expect, test } from '@playwright/test'

import { cleanupTestUser, resetE2ERateLimits, seedAppUser, testUser } from '../helpers/seedUser'

import type { Page } from '@playwright/test'

type ExpectedGroup = {
  destinations: readonly string[]
  landing?: string
  label: 'Billing' | 'Manage' | 'Settings'
}

const primaryDestinations = ['My time', 'Add time'] as const

const destinationGroups = [
  {
    destinations: ['Export history'],
    landing: 'Billing queue',
    label: 'Billing',
  },
  {
    destinations: ['Customer billing', 'Project billing'],
    label: 'Manage',
  },
  {
    destinations: ['Invoice defaults', 'Xero accounting', 'Operations', 'Payload Admin'],
    label: 'Settings',
  },
] as const satisfies readonly ExpectedGroup[]

const viewportWidths = [390, 621, 768, 850, 1024, 1180, 1280, 1440] as const

const pathPattern = (path: string): RegExp =>
  new RegExp(`${path.replaceAll('/', '\\/').replaceAll('?', '\\?')}$`)

async function signIn(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email address').fill(testUser.email)
  await page.getByLabel('Password').fill(testUser.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(pathPattern('/app'))
}

const desktopNavigation = (page: Page) => page.locator('.desktop-navigation')

const accountTrigger = (page: Page) =>
  page.getByRole('button', { name: new RegExp(testUser.displayName) })

test.describe.serial('Application navigation', () => {
  test.beforeAll(async () => {
    await seedAppUser()
  })

  test.afterAll(async () => {
    await cleanupTestUser()
  })

  test.beforeEach(async () => {
    await resetE2ERateLimits()
  })

  test('shows every workflow destination', async ({ page }) => {
    await signIn(page)

    const shell = desktopNavigation(page)
    const primary = shell.getByRole('navigation', { name: 'Primary' })
    await expect(shell).toBeVisible()

    for (const label of primaryDestinations) {
      await expect(shell.getByRole('link', { name: label, exact: true })).toBeVisible()
    }

    for (const group of destinationGroups) {
      const trigger = primary.getByRole('button', {
        name: group.label === 'Billing' ? 'Open Billing menu' : group.label,
        exact: true,
      })

      if ('landing' in group) {
        await expect(shell.getByRole('link', { name: group.label, exact: true })).toBeVisible()
      }
      await trigger.click()
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      const panel = page.locator(`#nav-group-${group.label.toLowerCase()}`)
      for (const destination of group.destinations) {
        await expect(panel.getByRole('link', { name: new RegExp(destination) })).toBeVisible()
      }
      if (group.label === 'Settings') await expect(panel.getByText('Advanced')).toBeVisible()
    }

    await expect(page.getByRole('link', { name: /People|Invitations/i })).toHaveCount(0)
    await expect(shell.getByRole('link', { name: 'Profile', exact: true })).toHaveCount(0)
    await expect(accountTrigger(page)).toBeVisible()
  })

  test('the brand and the Billing landing lead to their pages', async ({ page }) => {
    await signIn(page)

    const shell = desktopNavigation(page)
    await shell.getByRole('link', { name: 'Billing', exact: true }).click()
    await expect(page).toHaveURL(pathPattern('/app/billing'))
    await expect(shell.getByRole('link', { name: 'Billing', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await shell.getByRole('button', { name: 'Open Billing menu', exact: true }).click()
    await page.locator('#nav-group-billing').getByRole('link', { name: 'Export history' }).click()
    await expect(page).toHaveURL(pathPattern('/app/billing/exports'))

    const brand = page.locator('.app-brand')
    await expect(brand).toHaveAttribute('href', '/app')
    await brand.click()
    await expect(page).toHaveURL(pathPattern('/app'))
  })

  test('reaches Manage and Settings children with active-page context', async ({ page }) => {
    await signIn(page)

    const shell = desktopNavigation(page)
    await shell.getByRole('button', { name: 'Manage', exact: true }).click()
    await page.locator('#nav-group-manage').getByRole('link', { name: 'Customer billing' }).click()
    await expect(page).toHaveURL(pathPattern('/app/settings/customers'))

    await desktopNavigation(page).getByRole('button', { name: 'Manage', exact: true }).click()
    await expect(
      page.locator('#nav-group-manage').getByRole('link', { name: 'Customer billing' }),
    ).toHaveAttribute('aria-current', 'page')

    await desktopNavigation(page).getByRole('button', { name: 'Settings', exact: true }).click()
    await page
      .locator('#nav-group-settings')
      .getByRole('link', { name: 'Invoice defaults' })
      .click()
    await expect(page).toHaveURL(pathPattern('/app/settings/billing'))

    await desktopNavigation(page).getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(
      page.locator('#nav-group-settings').getByRole('link', { name: 'Invoice defaults' }),
    ).toHaveAttribute('aria-current', 'page')
  })

  test('reaches Profile and signs out from Account', async ({ page }) => {
    await signIn(page)

    await accountTrigger(page).click()
    await page.getByRole('link', { name: 'Profile', exact: true }).click()
    await expect(page).toHaveURL(pathPattern('/app/profile'))
    await expect(
      page.getByRole('heading', { level: 1, name: 'Profile', exact: true }),
    ).toBeVisible()

    await accountTrigger(page).click()
    await expect(page.getByRole('link', { name: 'Profile', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(pathPattern('/login'))
  })

  test('Escape closes desktop and mobile menus and restores trigger focus', async ({ page }) => {
    await signIn(page)

    const manageTrigger = desktopNavigation(page).getByRole('button', {
      name: 'Manage',
      exact: true,
    })
    await manageTrigger.focus()
    await manageTrigger.press('Enter')
    await expect(manageTrigger).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(manageTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(manageTrigger).toBeFocused()

    const userTrigger = accountTrigger(page)
    await userTrigger.focus()
    await userTrigger.press('Space')
    await expect(userTrigger).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(userTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(userTrigger).toBeFocused()

    await page.setViewportSize({ height: 900, width: 768 })
    const mobileTrigger = page.getByRole('button', { name: 'Menu', exact: true })
    await mobileTrigger.focus()
    await mobileTrigger.press('Enter')
    await expect(mobileTrigger).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(mobileTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(mobileTrigger).toBeFocused()
  })

  test('navigation does not overflow supported viewports', async ({ page }) => {
    await signIn(page)

    for (const width of viewportWidths) {
      await page.setViewportSize({ height: 900, width })

      if (width <= 1080) {
        const menuTrigger = page.getByRole('button', { name: 'Menu', exact: true })
        await expect(menuTrigger).toBeVisible()
        if ((await menuTrigger.getAttribute('aria-expanded')) !== 'true') {
          await menuTrigger.click()
        }
        const mobilePanel = page.getByRole('navigation', { name: 'Mobile primary' })
        await expect(mobilePanel).toBeVisible()
        await expect(mobilePanel.getByRole('link', { name: 'My time', exact: true })).toBeVisible()
        await expect(
          page.getByRole('link', { name: 'Add time', exact: true }).filter({ visible: true }),
        ).toBeVisible()
        for (const group of destinationGroups) {
          if ('landing' in group) {
            await expect(
              mobilePanel.getByRole('link', { name: group.landing, exact: true }),
            ).toBeVisible()
          }
          for (const destination of group.destinations) {
            await expect(
              mobilePanel.getByRole('link', { name: new RegExp(destination) }),
            ).toBeVisible()
          }
        }
        await expect(mobilePanel.getByRole('link', { name: 'Profile', exact: true })).toBeVisible()
        await expect(mobilePanel.getByRole('button', { name: 'Sign out' })).toBeVisible()
      } else {
        await expect(desktopNavigation(page)).toBeVisible()
      }

      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          }),
      )
      const dimensions = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }))

      expect(dimensions.documentWidth, `document width at ${width}px`).toBeLessThanOrEqual(
        dimensions.viewportWidth,
      )
    }
  })
})
