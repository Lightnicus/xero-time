# Plan 002: Put recording and reviewing time first

> **Executor instructions**: Follow the steps and verification gates in order.
> Stop on any listed STOP condition. When complete, update this plan's status in
> `advisor-plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 24f0252..HEAD -- 'app/src/app/(frontend)/app/page.tsx' 'app/src/app/(frontend)/app/time' 'app/src/app/(frontend)/_components/TimeEntryForm.tsx' 'app/src/app/(frontend)/styles.css' 'app/tests/e2e/frontend.e2e.spec.ts'`
> Reconcile any changed filter, form, or action contract before proceeding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/001-role-aware-navigation.md`
- **Category**: UX / tech debt
- **Planned at**: commit `24f0252`, 2026-07-21

## Why this matters

My time is the core member workflow, but the entry list begins only after a
six-field filter form, three large metric cards, and a second daily/weekly totals
panel. On a 390px viewport, users scroll past roughly three screens before they
reach their entries. Add time is also presented as two large numbered cards even
though the page already has safe defaults for project, date, duration, billable
state, and timezone. This plan makes frequent work compact without removing
advanced capability.

## Current state

- `app/src/app/(frontend)/app/page.tsx:146-257` renders period controls and six
  filters before results.
- `app/src/app/(frontend)/app/page.tsx:259-275` renders three hero-style metrics;
  `:277-330` repeats aggregation in daily and weekly totals.
- `app/src/app/(frontend)/app/page.tsx:332` is where the actual entry list starts.
- `app/src/app/(frontend)/_components/TimeEntryForm.tsx:124-186` renders a large
  Work details card and `:188-348` renders a second Time card.
- `TimeEntryForm.tsx:316-341` always exposes the IANA timezone field, even though
  `app/time/new/page.tsx:35-68` supplies the user's timezone and sensible defaults.
- `TimeEntryForm.tsx:168` explains an internal Xero invoice-line consequence in
  the primary work-description flow.
- Page headings and breadcrumbs are repeated at 15+ call sites. Introduce a
  small `PageHeader` primitive here and prove it on My time/Add/Edit time before
  broader adoption in Plan 004.

## Commands you will need

Run from `app/`.

| Purpose               | Command                                                                                  | Expected on success        |
| --------------------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| Typecheck/lint/format | `pnpm check`                                                                             | exit 0                     |
| Unit tests            | `pnpm test:unit`                                                                         | all pass                   |
| Member browser flow   | `pnpm exec playwright test --config=playwright.config.ts tests/e2e/frontend.e2e.spec.ts` | all tests pass             |
| Performance guard     | `pnpm test:perf`                                                                         | all performance cases pass |

## Suggested executor toolkit

- Use the project `frontend-design` and `distill` guidance for progressive
  disclosure and information hierarchy.
- If a client component needs synchronization with a browser API, consult
  `react-useeffect-guide`; do not add Effects for derived UI state.

## Scope

**In scope**:

- `app/src/app/(frontend)/app/page.tsx`
- `app/src/app/(frontend)/app/time/new/page.tsx`
- `app/src/app/(frontend)/app/time/[id]/edit/page.tsx`
- `app/src/app/(frontend)/_components/TimeEntryForm.tsx`
- New focused primitives in `app/src/app/(frontend)/_components/`, expected to
  include `PageHeader.tsx`, `FilterDisclosure.tsx`, and a responsive time-entry
  list component if markup—not CSS alone—is needed
- `app/src/app/(frontend)/styles.css`
- `app/tests/e2e/frontend.e2e.spec.ts`
- Direct unit tests for any extracted pure filter/presentation model

**Out of scope**:

- Time-entry validation, overlap rules, billing locks, server actions, or URL
  filter parameter names.
- Removing daily/weekly reporting data from the server response.
- Adding a running timer, autosave, or new product feature.
- Billing queue changes; those belong to Plan 003.
- A global typography/rebrand project.

## Git workflow

- Suggested branch: `advisor/002-time-workflow`.
- Suggested commit message: `prioritise the core time workflow`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Lock the current time-entry behavior with E2E assertions

Before rearranging markup, retain coverage for:

- create, edit, duplicate, and delete;
- duration and start/finish input;
- daylight-saving validation and overlap confirmation;
- project/customer/status/billable filters and URL persistence;
- daily/weekly totals for a known fixture;
- locked entry behavior;
- member keyboard and 390px viewport behavior.

Add a test proving filtered entry identity/count does not change when advanced
filters are disclosed or collapsed.

**Verify**: `pnpm exec playwright test --config=playwright.config.ts tests/e2e/frontend.e2e.spec.ts`
passes before production markup changes.

### Step 2: Extract a small, consistent page header

Create a `PageHeader` that accepts title, optional short description, optional
breadcrumb, and optional action. It must not force an eyebrow label; use one only
when it provides information not already in the title/breadcrumb. Adopt it on My
time, Add time, and both edit/read-only time-entry states.

With Plan 001 providing one persistent Add time action, remove the duplicated
page-heading Add time button on a populated My time page. Retain an Add time
button in the true no-entries empty state because it teaches the next action.

**Verify**: headings remain unique (`getByRole('heading', { level: 1 })` has one
match per page) and breadcrumbs retain meaningful accessible labels.

### Step 3: Put the entry list directly after compact period controls

Reorder My time to:

1. Page header.
2. Compact day/week/all switch plus Previous, Today, Next.
3. A single inline summary (total time and entry count; include billable total
   only if it remains scannable).
4. Time entries.
5. Optional daily/weekly breakdown.

Project, Customer, Billing status, and Billable move under a labelled More
filters disclosure. Keep View/date controls in the compact period bar. When an
advanced filter is active, expose its state outside the closed disclosure with
an active-filter count or removable chips; Clear filters must remain obvious.
Keep the existing GET parameters and server normalization unchanged.

Replace the three tall summary cards with a compact `MetricStrip` or inline
summary suitable for reuse in Plan 003. Move daily/weekly totals behind a View
breakdown disclosure after the list. Do not render rows of zero-value dates when
there are no entries; the empty state and one zero total already communicate the
state.

**Verify**: at 390px, the Time entries heading or the first entry is reachable
within the first two viewport heights, and all existing filter assertions pass.

### Step 4: Make time entries adapt rather than require a desktop table

Preserve a compact desktop table. At phone widths, present each entry as a
stacked, labelled row/card with project and description first, followed by date,
duration, status, and Edit. Avoid an unlabelled horizontal-scroll dependency.
Use one data source and ensure hidden responsive variants do not create duplicate
focus targets or screen-reader content.

**Verify**: at 390px there is no document overflow, all fields for a fixture
entry are visible without horizontal scrolling, and Edit is keyboard reachable.

### Step 5: Flatten Add time around the defaults users actually need

Present one compact form in this order:

- Project
- Description
- Work date
- Hours and minutes (default) or Start and finish when that mode is selected
- Billable
- primary Add time action

Keep the mode switch, but remove the oversized numbered-section treatment for a
routine form. Show the current timezone as brief context and put the editable
timezone control under Change timezone / Advanced. Keep the field in the form
and submit exactly the same value; do not alter server validation or DST logic.

Replace “This will become the description for its mapped Xero invoice line”
with user-facing guidance such as “Describe the completed work clearly enough
for the customer invoice.” Do not mention Xero implementation details in the
primary path.

Keep privileged correction-reason and overlap-confirmation controls visible when
they are actually required; progressive disclosure must not hide an active error
or required confirmation.

**Verify**: all create/edit/duplicate/DST/overlap E2E cases pass unchanged in
behavior, and the phone form reaches its submit action with materially less
vertical scrolling than the current two-card layout.

### Step 6: Remove styles made obsolete by the new composition

Delete unused three-card time-summary, numbered form-section, and time-table
mobile rules only after `rg` proves they have no consumers. Keep shared rules
still used by Billing, export detail, Profile, or Settings until those plans
adopt the new primitives.

**Verify**: `pnpm check && pnpm test:perf` exits 0.

## Test plan

- Preserve all current time lifecycle cases in `frontend.e2e.spec.ts`.
- Add collapsed/expanded More filters coverage with active filter state visible.
- Add no-results and first-entry mobile composition checks.
- Add keyboard traversal through period controls, disclosure, first row, and
  Add/Edit action.
- Add accessible-name checks for responsive row labels.
- Confirm owner/admin correction controls and member controls still diverge as
  before.

## Done criteria

- [ ] Entries appear before secondary breakdowns.
- [ ] Advanced filters are disclosed without losing active-filter visibility.
- [ ] The three tall My time metric cards are gone.
- [ ] Zero-only daily rows are not rendered for an empty period.
- [ ] Phone time entries require no horizontal scrolling.
- [ ] Add time is one compact form; timezone is available but not dominant.
- [ ] URL parameters and server action payloads are unchanged.
- [ ] All existing lifecycle, DST, overlap, lock, and filter tests pass.
- [ ] `pnpm check`, `pnpm test:unit`, `pnpm test:perf`, and the member E2E suite
      pass.

## STOP conditions

Stop and report if:

- Simplification requires dropping a submitted field or changing action input.
- A collapsed section would hide an active validation error or required safety
  confirmation.
- Responsive markup creates duplicate interactive/accessibility trees.
- The current filter URL contract cannot be preserved.
- Performance tests regress due to duplicate result rendering.

## Maintenance notes

The default workflow should stay compact as new filters or entry modes are
added. New advanced controls belong in the existing disclosures, not ahead of
the entry list. Reuse `PageHeader`, `FilterDisclosure`, and `MetricStrip` only
where their semantics match; do not recreate a universal card wrapper.
