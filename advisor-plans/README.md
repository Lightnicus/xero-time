# Frontend cleanup plans

Generated from a read-only UI and code review on 2026-07-21 at commit `24f0252`.
The existing `plans/` directory contains the product delivery plan, so these
review plans live separately in `advisor-plans/`.

## Recommended outcome

The member application should foreground the task each role performs most:

```text
Member
|- My time
|- Add time (primary action)
`- Account
   |- Profile & security
   `- Sign out

Biller
|- Billing (default destination)
|  |- Queue
|  `- Export history
`- Account
   |- Profile & security
   `- Sign out

Owner / Admin
|- My time
|- Billing
|  |- Queue
|  `- Export history
|- Manage
|  |- People & invitations
|  |- Customer billing
|  `- Project billing
|- Settings
|  |- Invoice defaults
|  |- Xero accounting
|  `- Advanced
|     |- Operations
|     `- Payload Admin (external destination)
|- Add time (primary action)
`- Account
   |- Profile & security
   `- Sign out
```

Remove Profile, Invoice defaults, People, Customers, Projects, Xero,
Operations, and Admin from the flat primary row. Do not delete those
capabilities: they are documented role functions and safety controls. Remove
only redundant UI—the business-name-only footer, duplicate Add time actions,
repeated metric cards, the separate All uninvoiced billing panel, and generic
eyebrow copy that restates a heading.

## Execution order and status

| Plan | Title                                                          | Priority | Effort | Depends on          | Status |
| ---- | -------------------------------------------------------------- | -------: | -----: | ------------------- | ------ |
| 001  | Replace the flat header with role-aware navigation             |       P1 |      M | -                   | TODO   |
| 002  | Put recording and reviewing time first                         |       P1 |      M | 001                 | TODO   |
| 003  | Reduce billing to one selection-to-review path                 |       P1 |    M-L | 001, 002 primitives | TODO   |
| 004  | Organise settings and progressively disclose advanced controls |       P2 |      M | 001, 002 primitives | TODO   |

Status values: TODO | IN PROGRESS | DONE | BLOCKED | REJECTED.

## Why this order

- Plan 001 fixes a reproduced responsive defect and establishes the role/menu
  contract that every later page relies on.
- Plan 002 creates the small shared presentation primitives needed by Billing
  and Settings, while improving the highest-frequency workflow first.
- Plan 003 is isolated because its selection semantics are billing-critical;
  its characterization tests must pass before UI consolidation starts.
- Plan 004 adopts the proven shell and primitives across lower-frequency admin
  surfaces without mixing that broad cleanup into the core workflow changes.

## Findings considered and deliberately deferred

- **Delete Operations or Payload Admin:** rejected. Both expose documented
  owner/admin capabilities. They should move under Advanced, not disappear.
- **Bring all Payload CRUD into the custom app:** deferred. The custom People,
  Customer, and Project pages intentionally expose specialised workflows and
  link to Payload for generic CRUD. Relabel those links honestly in this pass.
- **Full visual rebrand or new font dependency:** deferred. The immediate value
  is hierarchy, responsive behavior, and workflow clarity; a brand exercise
  would broaden scope without solving those problems.
- **Preserve every protected deep link through expired-session login:** valid
  adjacent correctness issue (`src/lib/member-app/session.ts:78` always sends
  users to `next=/app`), but it is security-sensitive auth-routing work and
  should receive its own plan rather than ride inside a navigation refactor.

## Review decision requested

Approve, reject, or amend the hierarchy and the four scopes before any source
implementation. In particular, confirm whether billers should have a secondary
My time link; the recommendation is to remove it from their menu because they
cannot create time and the Billing queue already exposes their operational
review surface.
