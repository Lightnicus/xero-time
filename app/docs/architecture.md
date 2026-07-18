# Architecture

Project Time is a single-business Next.js application deployed to Vercel, with Payload providing the data model, email/password authentication, generated owner/admin UI, Local API, and durable jobs. MongoDB is the system of record and must support multi-document transactions.

The custom `/app` UI serves members and billing operators. Payload Admin is restricted to active owners and administrators. Business commands enforce authorization again in the domain service; Admin visibility is never treated as authorization.

## Trust boundaries

- Xero identity uses a dedicated OAuth/OIDC client, requests only `openid profile email`, retains no provider token, and produces a hashed opaque local session.
- Xero accounting uses a different OAuth client configured through the protected application, encrypted rotating credentials, one pinned tenant, and minimum-purpose accounting scopes.
- Identity callbacks cannot select a tenant or call the accounting token service. Accounting callbacks cannot create users, identities, or application sessions.
- Invoice confirmation commits immutable snapshots and reservation intent before dispatch. Xero mutation and reconciliation jobs load the saved payload by export ID.
- Webhooks are authenticated over the exact raw body, persisted minimally, and processed asynchronously. Remote changes never release time automatically.

## Source boundaries

- `src/collections` and `src/globals`: Payload schema and invariant hooks.
- `src/access`: role, collection, and field authorization.
- `src/lib/account-lifecycle`, `identity`, and `member-app`: invitations and authentication/application sessions.
- `src/lib/billing`, `projects`, and `time-entry`: business commands and exact arithmetic.
- `src/lib/xero/accounting` and `xero/export`: accounting credential/client and export saga.
- `src/app/(frontend)`: custom pages and bounded route handlers; `src/app/(payload)` contains Payload Admin.
- `tests`: unit, real replica-set integration, and Playwright browser coverage.

Mongo IDs and Xero IDs remain durable references; names and financial values used for billing are immutable snapshots. Historical records survive user, customer, and project archival.
