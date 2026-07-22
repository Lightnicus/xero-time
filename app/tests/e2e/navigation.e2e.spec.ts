import { expect, test } from '@playwright/test'

import {
  adminAppUser,
  billerAppUser,
  cleanupNavigationRoleFixture,
  memberAppUser,
  resetE2ERateLimits,
  seedNavigationRoleFixture,
  testUser,
} from '../helpers/seedUser'

import type { Page } from '@playwright/test'

type NavigationUser = {
  displayName: string
  email: string
  password: string
  role: 'admin' | 'biller' | 'member' | 'owner'
}

type ExpectedGroup = {
  destinations: readonly string[]
  landing?: string
  label: string
}

type RoleScenario = {
  groups: readonly ExpectedGroup[]
  home: '/app' | '/app/billing'
  primary: readonly string[]
  user: NavigationUser
}

const privilegedGroups = [
  {
    destinations: ['Export history'],
    landing: 'Billing queue',
    label: 'Billing',
  },
  {
    destinations: ['People & invitations', 'Customer billing', 'Project billing'],
    label: 'Manage',
    landing: undefined,
  },
  {
    destinations: ['Invoice defaults', 'Xero accounting', 'Operations', 'Payload Admin'],
    label: 'Settings',
    landing: undefined,
  },
] as const satisfies readonly ExpectedGroup[]

const roleScenarios = [
  {
    groups: privilegedGroups,
    home: '/app',
    primary: ['My time', 'Add time'],
    user: testUser,
  },
  {
    groups: privilegedGroups,
    home: '/app',
    primary: ['My time', 'Add time'],
    user: adminAppUser,
  },
  {
    groups: [
      {
        destinations: ['Export history'],
        landing: 'Billing queue',
        label: 'Billing',
      },
    ],
    home: '/app/billing',
    primary: [],
    user: billerAppUser,
  },
  {
    groups: [],
    home: '/app',
    primary: ['My time', 'Add time'],
    user: memberAppUser,
  },
] as const satisfies readonly RoleScenario[]

const allGroupLabels = ['Billing', 'Manage', 'Settings'] as const
const viewportWidths = [390, 621, 768, 850, 1024, 1180, 1280, 1440] as const

const includesLabel = (labels: readonly string[], label: string): boolean => labels.includes(label)

const pathPattern = (path: string): RegExp =>
  new RegExp(`${path.replaceAll('/', '\\/').replaceAll('?', '\\?')}$`)

async function signIn(page: Page, scenario: RoleScenario): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email address').fill(scenario.user.email)
  await page.getByLabel('Password').fill(scenario.user.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(pathPattern(scenario.home))
}

const desktopNavigation = (page: Page) => page.locator('.desktop-navigation')

const accountTrigger = (page: Page, user: NavigationUser) =>
  page.getByRole('button', { name: new RegExp(user.displayName) })

test.describe.serial('Role-aware application navigation', () => {
  test.beforeAll(async () => {
    await seedNavigationRoleFixture()
  })

  test.afterAll(async () => {
    await cleanupNavigationRoleFixture()
  })

  test.beforeEach(async () => {
    await resetE2ERateLimits()
  })

  for (const scenario of roleScenarios) {
    test(`${scenario.user.role} sees only authorised workflow destinations`, async ({ page }) => {
      await signIn(page, scenario)

      const shell = desktopNavigation(page)
      const primary = shell.getByRole('navigation', { name: 'Primary' })
      await expect(shell).toBeVisible()

      for (const label of ['My time', 'Add time'] as const) {
        const destination = shell.getByRole('link', { name: label, exact: true })
        if (includesLabel(scenario.primary, label)) await expect(destination).toBeVisible()
        else await expect(destination).toHaveCount(0)
      }

      for (const label of allGroupLabels) {
        const trigger = primary.getByRole('button', {
          name: label === 'Billing' ? 'Open Billing menu' : label,
          exact: true,
        })
        const expected = scenario.groups.find((group) => group.label === label)

        if (!expected) {
          await expect(trigger).toHaveCount(0)
          continue
        }

        if (expected.landing) {
          await expect(shell.getByRole('link', { name: label, exact: true })).toBeVisible()
        }
        await trigger.click()
        await expect(trigger).toHaveAttribute('aria-expanded', 'true')
        const panel = page.locator(`#nav-group-${label.toLowerCase()}`)
        for (const destination of expected.destinations) {
          await expect(panel.getByRole('link', { name: new RegExp(destination) })).toBeVisible()
        }
        if (label === 'Settings') await expect(panel.getByText('Advanced')).toBeVisible()
      }

      await expect(shell.getByRole('link', { name: 'Profile & security' })).toHaveCount(0)
      await expect(accountTrigger(page, scenario.user)).toBeVisible()
    })
  }

  test('biller login and brand both default to the billing queue', async ({ page }) => {
    const scenario = roleScenarios.find(({ user }) => user.role === 'biller')
    if (!scenario) throw new Error('The biller navigation scenario is missing.')

    await signIn(page, scenario)

    const shell = desktopNavigation(page)
    const billingLink = shell.getByRole('link', { name: 'Billing', exact: true })
    await expect(billingLink).toHaveAttribute('aria-current', 'page')
    const billingTrigger = shell.getByRole('button', { name: 'Open Billing menu', exact: true })
    await billingTrigger.click()
    const billingPanel = page.locator('#nav-group-billing')
    await billingPanel.getByRole('link', { name: 'Export history' }).click()
    await expect(page).toHaveURL(pathPattern('/app/billing/exports'))

    const brand = page.locator('.app-brand')
    await expect(brand).toHaveAttribute('href', '/app/billing')
    await brand.click()
    await expect(page).toHaveURL(pathPattern('/app/billing'))
  })

  test('owner reaches Manage and Settings children with active-page context', async ({ page }) => {
    const scenario = roleScenarios.find(({ user }) => user.role === 'owner')
    if (!scenario) throw new Error('The owner navigation scenario is missing.')

    await signIn(page, scenario)

    const shell = desktopNavigation(page)
    await shell.getByRole('button', { name: 'Manage', exact: true }).click()
    await page
      .locator('#nav-group-manage')
      .getByRole('link', { name: 'People & invitations' })
      .click()
    await expect(page).toHaveURL(pathPattern('/app/settings/users'))

    await desktopNavigation(page).getByRole('button', { name: 'Manage', exact: true }).click()
    await expect(
      page.locator('#nav-group-manage').getByRole('link', { name: 'People & invitations' }),
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

  for (const scenario of roleScenarios) {
    test(`${scenario.user.role} can reach Profile and sign out from Account`, async ({ page }) => {
      await signIn(page, scenario)

      await accountTrigger(page, scenario.user).click()
      await page.getByRole('link', { name: 'Profile & security' }).click()
      await expect(page).toHaveURL(pathPattern('/app/profile'))

      await accountTrigger(page, scenario.user).click()
      await expect(page.getByRole('link', { name: 'Profile & security' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      await page.getByRole('button', { name: 'Sign out' }).click()
      await expect(page).toHaveURL(pathPattern('/login'))
    })
  }

  test('Escape closes desktop and mobile menus and restores trigger focus', async ({ page }) => {
    const scenario = roleScenarios.find(({ user }) => user.role === 'owner')
    if (!scenario) throw new Error('The owner navigation scenario is missing.')

    await signIn(page, scenario)

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

    const userTrigger = accountTrigger(page, scenario.user)
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

  for (const scenario of roleScenarios) {
    test(`${scenario.user.role} navigation does not overflow supported viewports`, async ({
      page,
    }) => {
      await signIn(page, scenario)

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
          for (const destination of scenario.primary.filter((label) => label !== 'Add time')) {
            await expect(
              mobilePanel.getByRole('link', { name: destination, exact: true }),
            ).toBeVisible()
          }
          if (includesLabel(scenario.primary, 'Add time')) {
            await expect(
              page.getByRole('link', { name: 'Add time', exact: true }).filter({ visible: true }),
            ).toBeVisible()
          }
          for (const group of scenario.groups) {
            if (group.landing) {
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
          await expect(
            mobilePanel.getByRole('link', { name: 'Profile & security', exact: true }),
          ).toBeVisible()
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

        expect(
          dimensions.documentWidth,
          `${scenario.user.role} document width at ${width}px`,
        ).toBeLessThanOrEqual(dimensions.viewportWidth)
      }
    })
  }
})
