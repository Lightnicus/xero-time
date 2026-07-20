# Plan 004: Organise settings and progressively disclose advanced controls

> **Executor instructions**: Complete Plans 001-003 first so this plan adopts
> proven shell and page primitives. Follow each verification gate, stop on any
> STOP condition, and update `advisor-plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 24f0252..HEAD -- 'app/src/app/(frontend)/app/settings' 'app/src/app/(frontend)/app/operations/page.tsx' 'app/src/app/(frontend)/app/profile/page.tsx' 'app/src/app/(frontend)/_components' 'app/src/app/(frontend)/styles.css' 'app/tests/e2e'`
> Reconcile changed route guards, security confirmations, or action destinations
> before proceeding.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/001-role-aware-navigation.md` and the shared
  primitives proven by `advisor-plans/002-time-workflow.md`
- **Category**: UX / tech debt
- **Planned at**: commit `24f0252`, 2026-07-21

## Why this matters

The URL tree already groups five settings routes, but the interface flattens
them into the global header and every breadcrumb points back to My time. Several
labels also imply full entity management when the custom pages actually perform
specialised billing/invitation tasks and link to Payload Admin for generic CRUD.
Routine work shares long pages with rare, destructive controls. This plan makes
the existing architecture visible without deleting important operator features.

## Current state

- `app/src/app/(frontend)/app/settings/` contains Billing, People, Customers,
  Projects, and Xero routes but no shared settings layout or landing page.
- Settings breadcrumbs point to My time in Customers (`page.tsx:92-95`),
  Projects (`:110-113`), People (`:66-69`), and Xero (`:89-92`).
- Customer billing links to generic customer CRUD in Payload Admin
  (`settings/customers/page.tsx:97-108`). Project billing does the same for
  projects (`settings/projects/page.tsx:115-126`), and People does the same for
  active users (`settings/users/page.tsx:72-80`).
- People places routine invitations beside ownership transition and compromised
  Xero identity recovery (`settings/users/page.tsx:83-203`).
- Xero places connection/reference controls beside authorizer handover and
  disconnect (`settings/xero/page.tsx:361-429`).
- Operations is safe diagnostics, audit, and integration health
  (`app/operations/page.tsx:135-257`), not a daily workflow.
- `styles.css` is 1,639 lines; shared heading markup appears at 15+ call sites.
  Some class names have drifted: `filter-bar` is used by Customers without a
  matching rule, while Operations uses `table-scroll` instead of the defined
  `table-wrap` pattern.

## Commands you will need

Run from `app/` with MongoDB running for E2E.

| Purpose                      | Command                                                                                                                                            | Expected on success     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Typecheck/lint/format        | `pnpm check`                                                                                                                                       | exit 0                  |
| Unit tests                   | `pnpm test:unit`                                                                                                                                   | all pass                |
| Integration tests            | `pnpm test:int`                                                                                                                                    | all pass                |
| Frontend/admin browser tests | `pnpm exec playwright test --config=playwright.config.ts tests/e2e/frontend.e2e.spec.ts tests/e2e/admin.e2e.spec.ts tests/e2e/billing.e2e.spec.ts` | all selected tests pass |
| Production build             | `pnpm build`                                                                                                                                       | exit 0                  |

## Suggested executor toolkit

- Use `frontend-design`, `distill`, and `clarify` for hierarchy, progressive
  disclosure, and exact labels.
- Use `harden` when handling long names, empty collections, and advanced action
  states; preserve existing server validation.

## Scope

**In scope**:

- New `app/src/app/(frontend)/app/settings/layout.tsx` and
  `app/src/app/(frontend)/app/settings/page.tsx`
- Existing pages under `app/src/app/(frontend)/app/settings/`
- `app/src/app/(frontend)/app/operations/page.tsx`
- `app/src/app/(frontend)/app/profile/page.tsx` and account/security presentation
- Shared presentational components under `_components/`, adopting `PageHeader`,
  `Notice`, `EmptyState`, and disclosure patterns only where repetition is real
- `app/src/app/(frontend)/styles.css`
- Existing frontend/admin/billing E2E specs

**Out of scope**:

- Moving generic Payload CRUD into the custom app.
- Deleting Operations, audit history, ownership recovery, Xero handover, or Xero
  disconnect.
- Changing role guards, confirmation phrases, password checks, audit reasons,
  or action implementations.
- Changing route URLs unless a redirect preserves every existing bookmark and
  callback; the recommended cleanup keeps current URLs.
- Redesigning Payload Admin.

## Git workflow

- Suggested branch: `advisor/004-settings-component-cleanup`.
- Suggested commit message: `organise settings and advanced controls`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a guarded Settings parent and truthful local navigation

Create an owner/admin-only Settings landing page and layout. Reuse the same role
guard as the child pages. The local navigation should expose:

- People & invitations (`/app/settings/users`)
- Customer billing (`/app/settings/customers`)
- Project billing (`/app/settings/projects`)
- Invoice defaults (`/app/settings/billing`)
- Xero accounting (`/app/settings/xero`)
- Advanced: Operations and Payload Admin

Use a compact sidebar/local nav on wide screens and a labelled disclosure or
select-style nav on phones. Mark the current child with `aria-current`. Update
breadcrumbs to `Settings / Current page`; Invoice defaults may also keep a
contextual Back to Billing link because it is part of billing setup.

The Settings landing page should be a short grouped list with one-sentence task
descriptions, not another grid of generic cards.

**Verify**: an owner and admin can reach every item through Settings; member and
biller cannot see or directly access Settings.

### Step 2: Relabel specialised surfaces and make Payload boundaries explicit

Use labels that describe what each custom page actually does:

- People -> People & invitations
- Customers -> Customer billing
- Projects -> Project billing
- Admin -> Advanced administration / Payload Admin

Keep the current broader page titles where needed for precision, but align menu,
breadcrumb, and metadata. Change “Edit local customers/projects” and “Manage
active users” links to clearly indicate that they open Payload Admin. Add a
visual/explanatory external-admin cue without misusing `target="_blank"`.

**Verify**: link destinations stay identical and E2E locates each link by its
new truthful accessible name.

### Step 3: Separate routine tasks from rare high-impact controls

On People & invitations, keep invitation creation/history in the default flow.
Place Ownership transition and compromised Xero identity recovery in a clearly
labelled Advanced account administration disclosure. If an advanced action has
a success/error query state, automatically expose its section or put the status
outside the closed disclosure so feedback is never hidden.

On Xero accounting, keep connection status, connect/reconnect, and reference
refresh in the default flow. Put authorizer handover and Disconnect accounting
under Advanced Xero controls with clear danger hierarchy. Preserve all current
password, reason, checkbox, and audit requirements.

On Profile, combine display name/timezone under Profile and password/identity
sessions under Security. When Xero identity is not configured and there are no
external sessions, do not render a large mostly empty card; show one concise
availability note or omit the empty subsection. Never hide an active session or
available unlink/revoke control.

**Verify**: every destructive/high-impact flow remains keyboard reachable and
all existing confirmation/recovery E2E cases pass.

### Step 4: Adopt proven shared primitives without building a card framework

Replace repeated heading/breadcrumb markup with `PageHeader` across Settings,
Operations, Profile, billing history/detail, and Xero selection where the API
fits. Adopt shared Notice and EmptyState only if they preserve `role`,
`aria-live`, and tone semantics.

Do not create a universal `Card` component. Panels, forms, notices, metrics, and
data rows have different semantics and should remain distinct. Extract a
component only when at least three live call sites share structure and behavior.

Fix the evidenced class drift (`filter-bar`, `table-scroll`) by adopting an
existing supported primitive/class or adding one intentionally—do not leave
orphan class names.

**Verify**: `rg` shows no duplicate legacy PageHeader structure at adopted
sites, and no class name used by these pages lacks a corresponding style unless
it is intentionally a semantic hook.

### Step 5: Remove decorative/redundant chrome and normalize hierarchy

Remove eyebrow text that only repeats a heading/category (for example Your
account + Profile, Customers + Customer billing settings, and Business
integration + Xero accounting). Keep labels such as Action required or Read only
when they communicate state.

Reduce rounded shadow panels where plain grouped sections or dividers communicate
hierarchy more clearly. Keep strong containment for forms, warnings, and
financial previews. Operations should use a compact diagnostic list rather than
six identical metric cards; settings landing should use grouped links, not cards.

Use existing color tokens and focus styles. This is not authorization to add a
new font package, gradient, glass treatment, or decorative motion.

**Verify**: visual review at 390, 768, 1024, and 1440 pixels confirms clear
primary/secondary/advanced hierarchy and no horizontal overflow.

### Step 6: Prune obsolete styles after all call sites migrate

Use `rg` before deleting each selector. Group remaining global CSS sections by
foundation, shell/navigation, actions/forms, feedback, data display, and page-
specific exceptions. Splitting the file is optional; consistency and removal of
dead rules matter more than file count. Do not mix CSS Modules into only a few
components during this pass.

**Verify**: `pnpm check && pnpm build` exits 0, and no in-scope component uses an
undefined presentation class.

## Test plan

- Navigate to every settings child through Settings as owner and admin.
- Assert Settings/Operations/Payload Admin are absent for member and biller, and
  direct guards still deny them.
- Keyboard-test desktop and mobile settings navigation.
- Exercise invitations, ownership transition, identity recovery, Xero
  connect/reference controls, handover, and disconnect at their existing test
  safety level.
- Confirm an action result is visible even when its advanced disclosure would
  otherwise be closed.
- Test configured/unconfigured Profile security states and active sessions.
- Check long business/user/customer/project names at phone width.

## Done criteria

- [ ] Settings has a guarded landing/layout and local navigation.
- [ ] Every settings breadcrumb reflects the real parent.
- [ ] Menu labels describe the specialised task rather than implying full CRUD.
- [ ] Routine invitations/Xero setup precede rare high-impact controls.
- [ ] Advanced controls remain fully guarded, confirmed, and audited.
- [ ] Empty Profile security UI does not consume a large panel.
- [ ] Shared primitives replace evidenced repetition without a universal Card.
- [ ] Orphan `filter-bar`/`table-scroll` styling drift is resolved.
- [ ] Redundant eyebrows and generic metric-card layouts are reduced.
- [ ] `pnpm check`, unit/integration/E2E tests, and `pnpm build` pass.

## STOP conditions

Stop and report if:

- A shared settings layout changes or bypasses a child route guard.
- Progressive disclosure would hide an error, success state, or required
  confirmation.
- A relabel implies capabilities the custom page does not provide.
- Moving an advanced action requires changing its route/action/password/audit
  contract.
- Component extraction requires broad changes outside the custom frontend.

## Maintenance notes

New owner/admin configuration belongs under Settings or Manage, not the global
primary row. Rare diagnostic or destructive features belong under Advanced but
must remain directly linkable for runbooks. Keep generic CRUD boundaries clear:
specialised workflows live in the custom app; Payload Admin remains the explicit
advanced destination unless a separate product decision changes that boundary.
