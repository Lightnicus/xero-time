import { test, expect, type Page } from '@playwright/test'

import {
  cleanupTestUser,
  issueE2EPasswordResetToken,
  memberAppUser,
  resetE2ERateLimits,
  seedMemberAppFixture,
  seedMemberTimeEntries,
} from '../helpers/seedUser'

const datedTimeView = '/app?view=day&date=2026-07-18'

const openAccountMenu = async (
  page: Page,
  displayName: string = memberAppUser.displayName,
): Promise<void> => {
  const accountTrigger = page.getByRole('button', { name: displayName })

  await accountTrigger.click()
  await expect(accountTrigger).toHaveAttribute('aria-expanded', 'true')
}

const openProfileFromAccount = async (
  page: Page,
  displayName: string = memberAppUser.displayName,
): Promise<void> => {
  await openAccountMenu(page, displayName)
  await page.getByRole('link', { name: 'Profile & security' }).click()
}

const signOutFromAccount = async (
  page: Page,
  displayName: string = memberAppUser.displayName,
): Promise<void> => {
  await openAccountMenu(page, displayName)
  await page.getByRole('button', { name: 'Sign out' }).click()
}

const openTimezoneDisclosure = async (page: Page): Promise<void> => {
  await page.getByText('Change timezone', { exact: true }).click()
}

test.describe.serial('Member time application', () => {
  test.beforeAll(async () => {
    await seedMemberAppFixture()
  })

  test.afterAll(async () => {
    await cleanupTestUser()
  })

  test.beforeEach(async () => {
    await resetE2ERateLimits()
  })

  test('requires authentication and gives every login failure the same message', async ({
    page,
  }) => {
    await page.goto('/app')

    await expect(page).toHaveURL(/\/login\?next=\/app$/)
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()

    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill('wrong-password-value')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByText('The email or password is incorrect.')).toBeVisible()
  })

  test('returns the same password-reset response for an unknown account', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('link', { name: 'Forgot your password?' }).click()

    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible()
    await page.getByLabel('Email address').fill('unknown-account@example.test')
    await page.getByRole('button', { name: 'Send reset instructions' }).click()
    await expect(
      page.getByText(
        'If an active account matches that address, password-reset instructions have been sent.',
      ),
    ).toBeVisible()
  })

  test('recovers a password and replaces the old credential', async ({ page }) => {
    test.setTimeout(60_000)
    const recoveredPassword = 'eight888'
    const resetToken = await issueE2EPasswordResetToken(memberAppUser.email)
    await page.goto(`/reset-password?token=${resetToken}`)
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()
    await page.getByLabel(/^New password/).fill(recoveredPassword)
    await page.getByLabel('Confirm new password').fill(recoveredPassword)
    await page.getByRole('button', { name: 'Set new password' }).click()

    await expect(page).toHaveURL(/\/app\/profile\?password=reset$/)
    await signOutFromAccount(page)
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('The email or password is incorrect.')).toBeVisible()

    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(recoveredPassword)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/app$/)
    await openProfileFromAccount(page)
    await page.getByLabel('Current password').fill(recoveredPassword)
    await page.getByLabel('New password', { exact: true }).fill(memberAppUser.password)
    await page.getByLabel('Confirm new password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Change password' }).click()
    await expect(page).toHaveURL(/\/app\/profile\?password=changed$/)
  })

  test('logs in a member with a secure cookie and supports the manual time lifecycle', async ({
    page,
  }) => {
    await page.goto('/login')
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL(/\/app$/)
    await expect(page.getByRole('heading', { name: 'My time' })).toBeVisible()

    const sessionCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'payload-token',
    )
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: false })
    expect(sessionCookie?.expires ?? 0).toBeGreaterThan(Date.now() / 1_000 + 60 * 60)

    await page.getByRole('link', { name: 'Add time' }).first().click()
    await expect(page.getByRole('heading', { name: 'Add time' })).toBeVisible()
    await expect(page.getByLabel('Project')).toHaveValue(/.+/)
    await expect(page.getByLabel('Project').locator('option')).toHaveCount(1)
    await expect(page.getByLabel('Project')).not.toContainText(
      'Unavailable Archived Customer Project',
    )

    await page.getByLabel('Description').fill('Prepared the customer reporting flow')
    await page.getByRole('spinbutton', { name: 'Hours', exact: true }).fill('1')
    await page.getByRole('spinbutton', { name: 'Minutes', exact: true }).fill('30')
    await page.getByRole('button', { name: 'Add time' }).click()

    await expect(page).toHaveURL(/\/app\?created=1$/)
    await expect(page.getByText('Time entry added.')).toBeVisible()
    await expect(page.getByText('Prepared the customer reporting flow')).toBeVisible()
    await expect(
      page
        .getByRole('row')
        .filter({ hasText: 'Prepared the customer reporting flow' })
        .getByText('1h 30m'),
    ).toBeVisible()

    await page.getByRole('link', { name: 'Edit' }).click()
    await page.getByLabel('Description').fill('Prepared and reviewed the customer reporting flow')
    await page.getByRole('button', { name: 'Save changes' }).click()

    await expect(page).toHaveURL(/\/app\?updated=1$/)
    await expect(page.getByText('Time entry updated.')).toBeVisible()
    await expect(page.getByText('Prepared and reviewed the customer reporting flow')).toBeVisible()

    await page.getByRole('link', { name: 'Edit' }).click()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Delete entry' }).click()

    await expect(page).toHaveURL(/\/app\?deleted=1$/)
    await expect(page.getByText('Time entry deleted.')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No time recorded yet' })).toBeVisible()
  })

  test('records a start/finish range and recovers from a daylight-saving gap', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await page.getByRole('link', { name: 'Add time' }).first().click()
    await page.getByRole('radio', { name: /Start and finish/ }).check()
    await page.getByLabel('Description').fill('Worked through a timezone-sensitive report')
    await page.locator('#startLocal').fill('2026-09-27T02:30')
    await page.locator('#endLocal').fill('2026-09-27T03:30')
    await page.getByRole('button', { name: 'Add time' }).click()

    await expect(
      page.getByText('Enter a valid, unambiguous start time in the selected timezone.'),
    ).toBeVisible()
    await expect(page.getByLabel('Description')).toHaveValue(
      'Worked through a timezone-sensitive report',
    )

    await page.locator('#startLocal').fill('2026-07-18T09:15')
    await page.locator('#endLocal').fill('2026-07-18T10:45')
    await page.getByRole('button', { name: 'Add time' }).click()

    await expect(page).toHaveURL(/\/app\?created=1$/)
    await page.goto(datedTimeView)
    const rangeRow = page
      .getByRole('row')
      .filter({ hasText: 'Worked through a timezone-sensitive report' })
    await expect(rangeRow.getByText('1h 30m')).toBeVisible()
    await expect(rangeRow.getByText('09:15–10:45')).toBeVisible()
  })

  test('duplicates an unlocked entry as a separate reviewed copy', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/app$/)

    await page.goto(datedTimeView)
    await expect(page.getByRole('heading', { name: 'My time' })).toBeVisible()
    const sourceRow = page
      .getByRole('row')
      .filter({ hasText: 'Worked through a timezone-sensitive report' })
    await expect(sourceRow).toBeVisible()
    await sourceRow.getByRole('link', { name: 'Edit' }).click()
    await page.getByRole('link', { name: 'Duplicate entry' }).click()

    await expect(page.getByRole('heading', { name: 'Duplicate time' })).toBeVisible()
    await expect(page.getByRole('radio', { name: /Start and finish/ })).toBeChecked()
    await expect(page.getByLabel('Description')).toHaveValue(
      'Worked through a timezone-sensitive report',
    )
    await openTimezoneDisclosure(page)
    await expect(page.locator('#timezone')).toHaveValue('Pacific/Auckland')
    await expect(page.locator('#startLocal')).toHaveValue('2026-07-18T09:15')
    await expect(page.locator('#endLocal')).toHaveValue('2026-07-18T10:45')

    await page.getByLabel('Description').fill('Duplicated timezone-sensitive report')
    await page.getByRole('button', { name: 'Add time' }).click()

    await expect(
      page.getByText(
        'This range overlaps another entry. Review both entries, then confirm if this is intentional.',
      ),
    ).toBeVisible()
    await page
      .getByRole('checkbox', { name: 'I reviewed the overlap and want to save this range.' })
      .check()
    await page.getByRole('button', { name: 'Add time' }).click()

    await expect(page).toHaveURL(/\/app\?created=1$/)
    await page.goto(datedTimeView)
    const duplicateRow = page
      .getByRole('row')
      .filter({ hasText: 'Duplicated timezone-sensitive report' })
    await expect(duplicateRow.getByText('1h 30m')).toBeVisible()
    await duplicateRow.getByRole('link', { name: 'Edit' }).click()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Delete entry' }).click()

    await expect(page).toHaveURL(/\/app\?deleted=1$/)
    await page.goto(datedTimeView)
    await expect(page.getByText('Duplicated timezone-sensitive report')).toHaveCount(0)
    await expect(page.getByText('Worked through a timezone-sensitive report')).toBeVisible()
  })

  test('updates member profile defaults without changing an existing entry timezone', async ({
    page,
  }) => {
    await page.goto('/login')
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await openProfileFromAccount(page)
    await expect(page.getByText(memberAppUser.email)).toBeVisible()
    await page.getByLabel('Display name').fill('Updated Time Member')
    await page.locator('#profileTimezone').fill('Mars/Olympus')
    await page.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByText('Select a valid IANA timezone.')).toBeVisible()

    await page.locator('#profileTimezone').fill('Australia/Sydney')
    await page.getByRole('button', { name: 'Save profile' }).click()

    await expect(page).toHaveURL(/\/app\/profile\?saved=1$/)
    await expect(page.getByText('Profile saved.')).toBeVisible()
    await expect(page.locator('.account-copy strong')).toHaveText('Updated Time Member')

    await page.getByRole('link', { name: 'Add time' }).first().click()
    await openTimezoneDisclosure(page)
    await expect(page.locator('#timezone')).toHaveValue('Australia/Sydney')
    await page.getByRole('link', { name: 'Cancel' }).click()
    await expect(page).toHaveURL(/\/app$/)

    await page.goto(datedTimeView)
    const existingRow = page
      .getByRole('row')
      .filter({ hasText: 'Worked through a timezone-sensitive report' })
    await existingRow.getByRole('link', { name: 'Edit' }).click()
    await openTimezoneDisclosure(page)
    await expect(page.locator('#timezone')).toHaveValue('Pacific/Auckland')

    await openProfileFromAccount(page, 'Updated Time Member')
    await page.getByLabel('Display name').fill(memberAppUser.displayName)
    await page.locator('#profileTimezone').fill(memberAppUser.timezone)
    await page.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByText('Profile saved.')).toBeVisible()
  })

  test('keeps older member entries accessible through pagination', async ({ page }) => {
    await seedMemberTimeEntries(25)

    await page.goto('/login')
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/app$/)

    await page.goto('/app?view=all')
    await expect(page.getByText('Page 1 of 2')).toBeVisible()
    const pagination = page.getByRole('navigation', { name: 'Time entry pages' })
    await pagination.getByRole('link', { name: 'Next' }).click()

    await expect(page).toHaveURL(/\/app\?.*page=2$/)
    await expect(page.getByText('Page 2 of 2')).toBeVisible()
    await expect(page.getByText('Pagination entry 01')).toBeVisible()
    await expect(
      page
        .getByRole('navigation', { name: 'Time entry pages' })
        .getByRole('link', { name: 'Previous' }),
    ).toBeVisible()
  })

  test('filters a day and reports complete daily and weekly totals', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await page.getByText('More filters', { exact: true }).click()
    await expect(page.getByLabel('Project')).toContainText('E2E-WEB')
    await page.getByLabel('View').selectOption('day')
    await page.getByLabel('Day or week containing').fill('2026-07-18')
    await page.getByRole('button', { name: 'Apply filters' }).click()

    await expect(page).toHaveURL(/view=day/)
    await expect(
      page.getByRole('region', { name: 'Time summary' }).getByText('1 entry'),
    ).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'Time summary' }).getByText('1h 30m').first(),
    ).toBeVisible()
    await expect(page.getByText('Worked through a timezone-sensitive report')).toBeVisible()
    await expect(page.getByText('Pagination entry 01')).toHaveCount(0)
    await page.getByText('View daily and weekly breakdown', { exact: true }).click()
    await expect(
      page.getByRole('region', { name: 'Time totals' }).getByText('1h 30m').first(),
    ).toBeVisible()

    await page.getByText('More filters', { exact: true }).click()
    await page.getByLabel('Billable').selectOption('no')
    await page.getByRole('button', { name: 'Apply filters' }).click()
    await expect(page.getByRole('heading', { name: 'No entries match this view' })).toBeVisible()

    await page.getByLabel('Billable').selectOption('')
    await page.getByLabel('Billing status').selectOption('reserved')
    await page.getByRole('button', { name: 'Apply filters' }).click()
    await expect(page.getByRole('heading', { name: 'No entries match this view' })).toBeVisible()

    await page.getByRole('link', { name: 'Clear filters' }).first().click()
    await expect(page.getByRole('heading', { name: 'My time' })).toBeVisible()
  })

  test('keeps the critical member flow usable at a phone viewport and by keyboard', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 })
    await page.goto('/login')
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).press('Enter')
    await expect(page).toHaveURL(/\/app$/)

    const addTime = page
      .locator('.mobile-navigation-controls')
      .getByRole('link', { name: 'Add time', exact: true })
    await addTime.focus()
    await expect(addTime).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'Add time' })).toBeVisible()

    await page.getByLabel('Description').focus()
    await expect(page.getByLabel('Description')).toBeFocused()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
  })

  test('changes a password, revokes the old credential, and can restore the fixture password', async ({
    page,
  }) => {
    const replacementPassword = 'replacement-member-password-123!'
    await page.goto('/login')
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await openProfileFromAccount(page)

    await page.getByLabel('Current password').fill(memberAppUser.password)
    await page.getByLabel('New password', { exact: true }).fill(replacementPassword)
    await page.getByLabel('Confirm new password').fill(replacementPassword)
    await page.getByRole('button', { name: 'Change password' }).click()
    await expect(page).toHaveURL(/\/app\/profile\?password=changed$/)
    await expect(page.getByText('Other browser sessions were revoked.')).toBeVisible()

    await signOutFromAccount(page)
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('The email or password is incorrect.')).toBeVisible()

    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(replacementPassword)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/app$/)
    await openProfileFromAccount(page)
    await page.getByLabel('Current password').fill(replacementPassword)
    await page.getByLabel('New password', { exact: true }).fill(memberAppUser.password)
    await page.getByLabel('Confirm new password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Change password' }).click()
    await expect(page).toHaveURL(/\/app\/profile\?password=changed$/)
  })

  test('logs out and revokes access to protected pages', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/app$/)

    const cookieBeforeDeniedRoute = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'payload-token',
    )
    expect(cookieBeforeDeniedRoute).toBeDefined()
    await page.goto('/app/settings/xero')
    const cookieAfterDeniedRoute = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'payload-token',
    )
    expect(cookieAfterDeniedRoute).toBeDefined()
    await expect(page).toHaveURL(/^http:\/\/localhost:3101\/app$/)

    await signOutFromAccount(page)

    await expect(page).toHaveURL(/\/login$/)
    await page.goto('/app')
    await expect(page).toHaveURL(/\/login\?next=\/app$/)
  })

  test('rejects a protocol-relative post-login destination', async ({ page }) => {
    await page.goto('/login?next=//example.com')
    await page.getByLabel('Email address').fill(memberAppUser.email)
    await page.getByLabel('Password').fill(memberAppUser.password)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL(/\/app$/)
  })
})
