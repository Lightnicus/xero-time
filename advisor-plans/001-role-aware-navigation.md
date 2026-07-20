# Plan 001: Replace the flat header with role-aware navigation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before continuing. If a
> STOP condition occurs, stop and report rather than improvising. When done,
> update this plan's row in `advisor-plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 24f0252..HEAD -- 'app/src/app/(frontend)/app/layout.tsx' 'app/src/app/(frontend)/styles.css' 'app/src/app/(frontend)/login' 'app/src/app/(frontend)/invite' 'app/src/lib/xero/identity' 'app/tests/e2e' 'app/tests/helpers/seedUser.ts'`
> If the cited markup, role rules, or authentication destinations changed,
> stop and reconcile this plan with the live code.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: correctness / tech debt / UX
- **Planned at**: commit `24f0252`, 2026-07-21

## Why this matters

Owners and administrators currently receive eleven equal-weight header links.
The rendered UI overflows the document at common tablet and small-desktop
widths: Chromium reproduced `scrollWidth > innerWidth` at 621, 768, 1024, 1180,
and 1280 pixels. Daily tasks, setup, diagnostics, and an external admin system
also compete at the same level. This plan fixes the responsive defect and makes
the core workflow obvious for every role.

## Current state

- `app/src/app/(frontend)/app/layout.tsx:9-64` owns the entire application shell.
- `app/src/app/(frontend)/app/layout.tsx:30-41` emits My time, Add time, Profile,
  Billing, five settings links, Operations, and Admin as one flat `<nav>`.
- `app/src/app/(frontend)/app/layout.tsx:44-50` separately renders user context
  and Sign out even though Profile is account-related.
- `app/src/app/(frontend)/styles.css:426-433` uses a three-column header with
  180px minimum side columns; `:466-479` makes the navigation a non-wrapping
  row; `:1578-1580` handles phones only by horizontal scrolling.
- `app/src/app/(frontend)/login/actions.ts:21-26,119` defaults every login to
  `/app`; `app/src/lib/member-app/session.ts:86-87` excludes billers from time
  entry; the biller landing notice at `app/page.tsx:140-143` confirms the page is
  review-only for them.
- Existing components use PascalCase files in
  `app/src/app/(frontend)/_components/`; continue that convention. Styling is
  global in `styles.css`; do not introduce a new styling dependency in this
  plan.

## Commands you will need

Run from `app/`.

| Purpose                | Command                                                                                                                | Expected on success     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Typecheck              | `pnpm typecheck`                                                                                                       | exit 0, no errors       |
| Lint                   | `pnpm lint`                                                                                                            | exit 0, no errors       |
| Format                 | `pnpm format:check`                                                                                                    | exit 0                  |
| Unit tests             | `pnpm test:unit`                                                                                                       | all tests pass          |
| Targeted browser tests | `pnpm exec playwright test --config=playwright.config.ts tests/e2e/frontend.e2e.spec.ts tests/e2e/billing.e2e.spec.ts` | all selected tests pass |

MongoDB must be running (`pnpm db:start`) before browser tests.

## Suggested executor toolkit

- Use the project `frontend-design` guidance for hierarchy and progressive
  disclosure.
- Use semantic buttons/links and native disclosure behavior where practical;
  do not add a menu library for this small shell.

## Scope

**In scope**:

- `app/src/app/(frontend)/app/layout.tsx`
- New shell components under `app/src/app/(frontend)/_components/`, expected to
  include `AppNavigation.tsx` and `AccountMenu.tsx`
- A pure role/navigation model under `app/src/lib/member-app/`
- The minimum login/invitation/identity return-path call sites needed to make
  Billing the default destination for billers
- `app/src/app/(frontend)/styles.css`
- `app/tests/helpers/seedUser.ts`
- New unit coverage for the role/navigation model
- Navigation-focused E2E coverage in the existing E2E files or one new,
  clearly named navigation spec

**Out of scope**:

- Route authorization changes; server guards remain the security boundary.
- Moving or deleting settings/operations routes.
- Preserving arbitrary nested routes after an expired session; this is deferred
  in the index because `requireAppSession` currently lacks requested-path
  context.
- New third-party UI dependencies.
- Any change under the user-owned untracked `.agents/` directory.

## Git workflow

- Use branch `advisor/001-role-aware-navigation` if a branch is requested.
- The recent repo does not consistently use Conventional Commits; use a clear
  message such as `simplify role-aware app navigation`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Characterize the four role variants before changing markup

Create a pure navigation model that returns visible destinations and a default
home for `member`, `biller`, `admin`, and `owner`. Unit-test the model first.
Extend E2E fixtures with admin and biller users; current fixtures cover only
owner and member (`tests/helpers/seedUser.ts:5-23`).

Required contract:

- Member: My time, Add time, Account; no Billing, Manage, Settings, Operations,
  or Payload Admin.
- Biller: Billing as the default/brand destination, Queue and Export history,
  Account; no Add time or privileged menus. Do not show My time unless the plan
  owner explicitly changes the recommendation.
- Admin/owner: My time, Billing, Manage, Settings, Add time, Account.
- Existing direct route guards continue to allow/deny exactly as before.

**Verify**:
`pnpm exec vitest run --config ./vitest.config.mts tests/unit/member-navigation.unit.spec.ts`
passes with all four role matrices asserted.

### Step 2: Extract the shell navigation and account menu

Keep `app/layout.tsx` responsible for loading the session and business settings,
then pass a small serializable role/navigation model to extracted components.

- Keep My time and Billing as direct task destinations for privileged roles.
- Render Add time once as a visually primary action, not as another equal nav
  link. Later pages may retain an Add time action only in a true empty state.
- Manage submenu: People & invitations, Customer billing, Project billing.
- Settings submenu: Invoice defaults, Xero accounting, then an Advanced group
  with Operations and `Payload Admin` marked as leaving the custom app.
- Account menu trigger: user display name (or compact avatar on mobile). Menu
  items: Profile & security and Sign out; keep role as contextual text.
- Mark the active destination with `aria-current="page"`.
- Menus must work by keyboard and touch, not hover alone. Enter/Space opens,
  Escape closes and returns focus, and tab order remains logical.

Do not duplicate permission logic in client-only code. The server-provided model
controls visibility; route guards remain unchanged.

**Verify**: `pnpm typecheck && pnpm lint` exits 0.

### Step 3: Replace horizontal scrolling with deliberate responsive disclosure

At desktop widths, show the compact task links, grouped menus, primary Add time
action, and account trigger on one line. At mobile/tablet widths, show brand,
Add time when allowed, account trigger, and a labelled Menu button; open a
vertical menu containing all authorised destinations.

Delete the `.app-nav { overflow-x: auto; }` fallback. Test at 390, 621, 768,
850, 1024, 1180, 1280, and 1440 pixels. At every width, the document must not
overflow horizontally and every authorised destination must be reachable.

**Verify**: the new Playwright viewport matrix asserts
`document.documentElement.scrollWidth <= window.innerWidth` for owner, admin,
biller, and member.

### Step 4: Make authentication entry points use the role home

Use one tested helper for the default post-auth/brand path. Update only default
destinations; continue honoring a validated explicit local `next` or stored
return path. The helper must never accept or construct an external URL.

Cover local login and the existing invitation/Xero identity default paths that
currently hard-code `/app`. A biller should arrive at `/app/billing`; other roles
remain at `/app`. Existing explicit Profile/Xero callback return paths remain
unchanged.

**Verify**: E2E proves a biller logs in to `/app/billing`, the brand returns to
Billing, and the existing external/protocol-relative redirect rejection still
passes.

### Step 5: Remove redundant shell chrome

Render the footer only when there is useful support contact content. Remove the
business-name-only footer seen when `supportEmail` is absent. Keep business name
and product context in the brand; do not repeat it at the bottom of every page.

**Verify**: a fixture without support email has no empty/redundant footer; a
fixture with support email exposes a keyboard-focusable help link.

## Test plan

- Unit-test exact role destination sets and role home paths.
- E2E-test visible and absent destinations for all four roles.
- Navigate to at least one Manage and one Settings child through the menu; keep
  direct-route tests for authorization/bookmarks.
- Test account Profile and Sign out for each role.
- Test keyboard open/traverse/close/focus-return behavior.
- Test touch/mobile disclosure and the eight viewport widths above.
- Keep the existing member create-time and owner billing tests green.

## Done criteria

- [ ] The owner/admin header no longer renders eleven peer links.
- [ ] No role/viewport combination creates document-level horizontal overflow.
- [ ] Every active route exposes `aria-current="page"` in the appropriate menu.
- [ ] Biller defaults to Billing and cannot see Add time or privileged menus.
- [ ] Profile and Sign out live in Account, not primary navigation.
- [ ] Operations and Payload Admin are reachable only under Advanced.
- [ ] The business-name-only footer is gone.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:unit`, and
      targeted E2E tests all pass.
- [ ] No files outside the in-scope application/test paths and
      `advisor-plans/README.md` are modified; pre-existing `.agents/` remains
      untouched.

## STOP conditions

Stop and report if:

- The role guards no longer match the four-role model described above.
- Role-aware defaulting would require weakening safe-return-path validation.
- Accessible menu behavior appears to require a new third-party dependency.
- A direct authorised route becomes inaccessible after grouping.
- Any step requires editing Payload Admin internals.

## Maintenance notes

Review future roles in both the navigation model and server authorization; one
must never substitute for the other. Any new global destination must be assigned
to a workflow group and included in the role matrix rather than appended as a
new peer link.
