# Architecture

Project Time is a single-business, single-user Next.js application deployed to Vercel. One person records time and turns it into draft invoices in Xero. Payload provides the data model, email/password authentication, the Admin UI, the Local API, and durable jobs. MongoDB is the system of record and must support multi-document transactions.

There are no roles. A signed-in user can use the custom `/app` UI and Payload Admin, and can run every command. Anonymous requests are denied. Business rules that protect money still apply to everyone: billed or reserved time is locked, invoice snapshots are immutable, and duplicate-invoice and double-billing checks run on every export.

## Trust boundaries

- Sign-in is Payload email/password only.
- Xero accounting uses one OAuth client configured in the signed-in app, encrypted rotating credentials, one pinned tenant, and minimum-purpose accounting scopes. Accounting callbacks cannot create users or application sessions.
- Invoice confirmation commits immutable snapshots and reservation intent before dispatch. Xero mutation and reconciliation jobs load the saved payload by export ID.
- Webhooks are authenticated over the exact raw body, persisted minimally, and processed asynchronously. Remote changes never release time automatically.

## Source boundaries

- `src/collections` and `src/globals`: Payload schema and invariant hooks.
- `src/access`: signed-in checks and field-level rules such as locked billed time.
- `src/lib/account-lifecycle` and `member-app`: password changes, password reset, and application sessions.
- `src/lib/billing` and `projects`: business commands and exact arithmetic.
- `src/lib/xero/accounting` and `xero/export`: accounting credential/client and export saga.
- `src/app/(frontend)`: custom pages and bounded route handlers; `src/app/(payload)` contains Payload Admin.
- `tests`: unit, real replica-set integration, and Playwright browser coverage.

Mongo IDs and Xero IDs remain durable references; names and financial values used for billing are immutable snapshots. Historical records survive customer and project archival. The audit log records events automatically.
