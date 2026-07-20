# Plan 003: Reduce billing to one selection-to-review path

> **Executor instructions**: Billing selection and reservation are financially
> sensitive. Complete the characterization gate before changing UI markup. Run
> every verification command, stop on a STOP condition, and update the status in
> `advisor-plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 24f0252..HEAD -- 'app/src/app/(frontend)/app/billing' 'app/src/app/(frontend)/_components/BillingSelectionToolbar.tsx' 'app/src/lib/billing' 'app/tests/e2e/billing.e2e.spec.ts'`
> Any change to selection tokens, filter normalization, preview hashes, or
> reservation behavior is a STOP condition until this plan is reconciled.

## Status

- **Priority**: P1
- **Effort**: M-L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/001-role-aware-navigation.md` and the
  presentation primitives introduced in `advisor-plans/002-time-workflow.md`
- **Category**: UX / correctness
- **Planned at**: commit `24f0252`, 2026-07-21

## Why this matters

The Billing queue currently presents seven filters, three large metrics, two
selection summaries, three competing preview actions, and two invoice-date
inputs. Users must infer the difference between Preview selected, Preview all
matching, and a separate All uninvoiced panel. The underlying safety model is
strong; the UI should express one clear decision: which eligible time should be
reviewed as draft invoices.

## Current state

- `app/src/app/(frontend)/app/billing/page.tsx:250-319` renders seven filter
  controls before the queue.
- `app/billing/page.tsx:326-342` renders three hero metric cards.
- `BillingSelectionToolbar.tsx` tracks visible selections and all-matching
  state, then exposes separate preview paths.
- `app/billing/page.tsx:431-448` offers Preview selected and Preview all matching.
- `app/billing/page.tsx:453-474` repeats Invoice date in a separate All uninvoiced
  panel with a third preview action.
- `app/billing/preview/page.tsx:206-260` confirms and reserves the selected
  preview, with copy that surfaces implementation details such as hashes,
  immutable snapshots, transactions, and durable jobs.
- `tests/e2e/billing.e2e.spec.ts:103-149` already proves selected and
  all-matching preview/reserve/cancel behavior. Extend this before consolidation.
- Billing arithmetic, eligibility, selection tokens, and reservations live under
  `app/src/lib/billing/`; they are explicitly out of scope for redesign.

## Commands you will need

Run from `app/` with MongoDB running.

| Purpose                   | Command                                                                                 | Expected on success     |
| ------------------------- | --------------------------------------------------------------------------------------- | ----------------------- |
| Typecheck/lint/format     | `pnpm check`                                                                            | exit 0                  |
| Billing unit tests        | `pnpm exec vitest run --config ./vitest.config.mts tests/unit/billing-*.unit.spec.ts`   | all selected tests pass |
| Billing integration tests | `pnpm exec vitest run --config ./vitest.config.mts tests/int/billing-*.int.spec.ts`     | all selected tests pass |
| Billing browser tests     | `pnpm exec playwright test --config=playwright.config.ts tests/e2e/billing.e2e.spec.ts` | all tests pass          |
| Performance guard         | `pnpm test:perf`                                                                        | all tests pass          |

## Suggested executor toolkit

- Use `frontend-design` and `clarify` guidance for hierarchy and outcome-focused
  copy.
- Reuse `PageHeader`, `FilterDisclosure`, and `MetricStrip` from Plan 002; do
  not create billing-specific copies of the same presentation primitives.

## Scope

**In scope**:

- `app/src/app/(frontend)/app/billing/page.tsx`
- `app/src/app/(frontend)/app/billing/preview/page.tsx`
- `app/src/app/(frontend)/_components/BillingSelectionToolbar.tsx`
- A focused new selection-scope component if it reduces complexity
- `app/src/app/(frontend)/styles.css`
- `app/tests/e2e/billing.e2e.spec.ts`
- Presentation-level unit tests for an extracted scope/view model

**Out of scope**:

- `app/src/lib/billing/` domain behavior, financial arithmetic, filter limits,
  selection-token validation, reservation transactions, export jobs, or Xero
  calls.
- Export detail recovery/release actions.
- Changing which roles can bill.
- Combining the Billing queue with Invoice defaults or Xero setup.
- Removing blocker/setup remediation.

## Git workflow

- Suggested branch: `advisor/003-billing-workflow`.
- Suggested commit message: `clarify billing selection and review flow`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Characterize all three existing selection scopes

Before production changes, extend E2E coverage to prove exact entry IDs/counts,
duration, value, invoice groups, and reference lineage for:

1. selected rows;
2. every eligible row matching the current filters;
3. all eligible uninvoiced rows without the current filters.

Cover changed/stale selection rejection and prove nothing is reserved until the
preview confirmation action. Retain reserve/cancel coverage for selected and
all-matching; add all-uninvoiced coverage if it is not already represented at a
lower layer.

**Verify**: billing unit, integration, and E2E commands all pass before markup
changes.

### Step 2: Replace three preview actions with one explicit scope and action

In one selection toolbar, offer an explicit scope control:

- Selected rows
- All matching current filters
- All uninvoiced

Show one human-readable summary for the chosen scope and one primary button:
**Review draft invoices**. Use one invoice-date control for every scope. When
Selected rows has zero selections, disable the action and explain why. When All
matching has no eligible results, do the same. Preserve the exact hidden inputs,
selection token/hash, and server action modes expected by current backend code.

Delete the separate All uninvoiced panel only after the consolidated control
submits the identical intent and all characterization tests pass.

**Verify**: the three scope E2E cases reach previews containing exactly the same
entries and totals as the baseline.

### Step 3: Make filters and summary support the decision

Keep the most common billing filters visible: date range, customer, and project.
Move User, Currency, and Blocker into the shared More filters disclosure. If an
advanced filter is active, show that state outside the closed disclosure. Keep
Clear filters obvious.

Replace the three tall metric cards with the compact `MetricStrip`: eligible
entries/time, prospective invoices, and pre-tax value. The queue and scope
decision must appear within the first two viewport heights on a 390px screen.

Keep Export history reachable through the Billing menu from Plan 001 and as a
contextual secondary link where it remains helpful; it must not compete with
Review draft invoices as a primary action.

**Verify**: filter URLs and all existing filter/remediation assertions remain
unchanged; no layout creates document overflow at 390px.

### Step 4: Adapt the dense billing table deliberately

Billing has denser financial information than My time. Retain a table if that is
the clearest desktop form, but at narrow widths provide either labelled stacked
rows or a clearly signposted horizontal viewport with the Select and identity
columns sticky. Never silently truncate customer/project, description, rate, or
amount. Provide a visible scroll cue if horizontal scrolling remains.

Selection checkboxes, Select visible, and Clear visible must remain keyboard
accessible and their summary must update with an `aria-live` announcement that
does not become noisy on every incidental focus change.

**Verify**: at 390px a user can identify, select, and review either fixture row
without guessing hidden columns; keyboard selection passes.

### Step 5: Rewrite confirmation copy around outcomes, not mechanisms

On the preview page, lead with:

- number of draft invoices;
- customers and line items;
- invoice date/due date;
- pre-tax/tax/total values;
- what will happen after confirmation.

Replace primary-path wording about checksums, immutable snapshots, transactions,
and durable jobs with plain outcomes. If operators need those details, place a
short Technical safeguards disclosure after the decision. Do not weaken warning
copy, confirmation requirements, or disabled states.

Use one clear primary action, such as **Create draft invoices**, if that matches
the existing server behavior. Retain Cancel/back to Billing as secondary.

**Verify**: action names remain unambiguous in Playwright role queries and every
existing confirmation/export assertion passes.

### Step 6: Remove obsolete billing-only styles and duplicated markup

Delete the All uninvoiced panel rules, duplicate invoice-date layout, and old
selection-summary styles only after `rg` confirms they have no consumers.
Continue using shared primitives rather than adding new generic card variants.

**Verify**: `pnpm check && pnpm test:perf` exits 0.

## Test plan

- Exact characterization for selected, all matching, and all uninvoiced.
- Zero-selection and zero-result disabled states.
- Changed-data/stale-token rejection.
- Setup blockers and entry-specific blockers remain visible and actionable.
- Responsive selection at 390px and intermediate widths.
- Keyboard selection, scope change, and primary review action.
- Existing preview, reserve, cancel, export history, and project-rate flows.
- Full billing unit/integration tests plus performance bounds.

## Done criteria

- [ ] Exactly one invoice-date control and one Review draft invoices action are
      present on Billing.
- [ ] The user explicitly chooses among the three existing scopes.
- [ ] The separate All uninvoiced panel is removed without semantic change.
- [ ] Advanced filters disclose progressively and expose active state.
- [ ] Compact metrics replace the three tall cards.
- [ ] Billing rows are understandable and operable at 390px.
- [ ] Confirmation copy describes outcomes while all safety controls remain.
- [ ] Exact selected/all-matching/all-uninvoiced characterization tests pass.
- [ ] `pnpm check`, billing unit/integration/E2E tests, and `pnpm test:perf` pass.

## STOP conditions

Stop and report if:

- The consolidated control cannot submit the current selection modes unchanged.
- Any scope returns different entry IDs, totals, invoice grouping, or reference
  lineage from its characterization baseline.
- A proposed simplification requires editing `src/lib/billing` domain logic.
- Reservation occurs before explicit confirmation.
- Responsive adaptation hides or truncates a financial value without a labelled
  alternative.

## Maintenance notes

Future selection scopes must join the single explicit scope control and receive
characterization coverage; they must not create another standalone preview
panel. Reviewers should scrutinize hidden inputs and action payloads even when a
change appears presentational.
