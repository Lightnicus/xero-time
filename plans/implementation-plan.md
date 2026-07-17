# Xero Time Tracker — Implementation Plan

Status: Approved scope, ready for implementation
Plan date: 18 July 2026
Target: Single-business application deployed to Vercel Pro
Application stack: Next.js, Payload CMS, MongoDB Atlas, TypeScript

## 1. Purpose

Build a secure internal time-tracking application for customer projects. Invited users authenticate by email/password or optional Xero sign-in and record completed time manually. Privileged users manage customers, projects, rates, billing settings, and the business Xero accounting connection. Billable time can be selected explicitly, or selected as all eligible unbilled entries matching an optional filter, previewed, and exported to new Xero draft invoices.

The plan is deliberately split into dependency-ordered work packages. Every package contains implementation tasks, verification work, and an acceptance gate. A package is complete only when its implementation, tests, documentation, and operational requirements are complete.

## 2. Confirmed product decisions

- The application serves one business and one Xero organisation.
- Payload CMS supplies the data model, generated administration UI, authentication, access control, migrations, and persisted jobs.
- MongoDB Atlas is the production database, using Payload's MongoDB/Mongoose adapter.
- Authentication remains invite-only. Email/password is supported, and invited users may optionally accept/link their account and sign in with Xero OpenID Connect.
- Xero identity sign-in and the business accounting connection use separate Xero app/client registrations, callback routes, scopes, state records, and token handling.
- Xero sign-in requests only `openid profile email`; it never requests `offline_access` or accounting scopes and never creates, refreshes, replaces, or revokes the business accounting connection.
- A successful application login may enqueue a non-blocking accounting-connection health check using the existing server-held accounting credentials. Login never waits for that check.
- Time-entry users do not have access to Payload Admin.
- V1 time entry is manual only:
  - enter a work date with local start and finish times; or
  - enter a duration in hours and minutes.
- V1 has no running timer and no approval workflow.
- Each user selects an IANA timezone; the business timezone is the fallback.
- Project hourly rates are used for billing.
- Customers exist locally and are explicitly mapped to Xero contacts.
- Privileged users can:
  - search for and select contacts already created in Xero;
  - import a Xero contact as a local customer;
  - link an existing local customer to a Xero contact; and
  - explicitly create a missing Xero contact from a local customer.
- An export creates a new Xero DRAFT accounts-receivable invoice.
- One invoice is created per Xero contact and currency.
- Every exported time entry maps to its own Xero invoice line.
- Each line carries the time-entry description and a durable local line-to-entry mapping.
- Exported entries are locked.
- Release and rebill is an explicit, reasoned, audited Admin action.
- The business Xero accounting connection uses the standard free OAuth 2.0 Authorization Code flow.
- Xero execution is controlled by an Admin setting:
  - background; or
  - wait for Xero.
- Vercel Pro is assumed so background jobs can normally be picked up within one minute.

## 3. Explicit V1 non-goals

- Multi-business or SaaS tenancy.
- Public self-registration, mandatory Xero login, MFA, or identity providers other than email/password and Xero.
- Using a frontend user's Xero identity tokens to own or renew the business accounting connection.
- Inferring local role, Admin access, or business membership from Xero identity or Xero organisation access.
- A running stopwatch/timer.
- Timesheet approval.
- Employee payroll or Xero Payroll integration.
- Xero Projects synchronisation.
- Partial billing of one time entry.
- Appending time to an existing Xero invoice.
- Automatically approving, sending, or paying invoices.
- Automatically releasing time merely because a Xero invoice was changed, deleted, or voided.
- Credit-note automation.
- Offline-first or native mobile applications.
- Arbitrary editing or deletion of successful export and audit records.

## 4. Architecture and boundaries

### 4.1 Runtime layout

    Next.js application on Vercel
    ├── Custom application routes
    │   ├── authentication and account pages
    │   ├── time-entry pages
    │   ├── billing queue and invoice preview
    │   └── export status pages
    ├── Payload routes
    │   ├── Admin
    │   ├── REST API
    │   └── Local API
    ├── Custom server routes
    │   ├── Xero identity sign-in/link start and callback
    │   ├── Xero accounting connect/reconnect and callback
    │   ├── Xero webhook
    │   ├── billing commands
    │   └── secured job runner
    ├── Payload jobs
    │   ├── create Xero invoice
    │   ├── reconcile uncertain export
    │   ├── refresh Xero accounting token
    │   └── refresh Xero reference data
    └── MongoDB Atlas

### 4.2 Responsibility boundaries

- Payload collection configuration defines ordinary data shape, basic validation, Admin forms, and coarse access control.
- Payload remains the source of truth for application users, roles, status, invitations, and sessions regardless of login method.
- Xero identity callbacks resolve an invited/linked local user and issue a local application session. Xero identity tokens are not application sessions and are discarded after validation.
- The Xero identity client and accounting client are isolated. Neither callback can read or mutate the other flow's state or credentials.
- Domain services own time calculations, billing eligibility, invoice construction, reservations, export state changes, release/rebill, and Xero accounting-token handling.
- Custom command endpoints invoke domain services. Financial operations are not exposed as unrestricted generic CRUD.
- Payload jobs orchestrate work; InvoiceExport documents are the source of truth for billing state.
- MongoDB transactions protect local multi-document changes. No transaction remains open across a Xero network call.
- Xero mutations use both a Xero idempotency key and a durable local application reference.

## 5. Roles and permission model

Roles and capabilities are assigned only on the local Payload user. Xero identity claims, Xero organisation membership, and the Xero user who authorized accounting access never grant application permissions.

### Owner

- Full custom-application access.
- Payload Admin access.
- User and role management.
- Business, billing, and security settings.
- Connect, disconnect, reconnect, and hand over the Xero accounting connection.
- Change export execution mode.
- Release and rebill.

### Admin

- Full operational custom-application access.
- Payload Admin access.
- Manage customers, projects, rates, and user accounts.
- Manage Xero contact mappings and reference-data mappings.
- Change export execution mode.
- Release and rebill.
- Cannot reveal decrypted Xero accounting tokens.

### Biller

- Custom billing area access.
- View billable rates and financial totals.
- Preview and request invoice exports.
- View export history and safe retry/reconcile actions.
- No generic Payload Admin access in V1.
- Cannot manage users, Xero credentials, or release/rebill exported time.

### Member

- Custom time-entry application only.
- View active projects needed to enter time.
- Create, read, update, and delete only their own unbilled time entries.
- Cannot view rates, invoice totals, billing settings, Xero data, exports, jobs, or Payload Admin.

## 6. Proposed Payload data model

The exact generated types and physical indexes are finalized in WP-02. Sensitive fields remain hidden from all generic APIs and are read only through narrow server services.

### Users collection

- email and Payload authentication fields.
- displayName.
- role: owner, admin, biller, or member.
- active.
- timezone: valid IANA timezone.
- invitedAt, inviteAcceptedAt, lastLoginAt.
- enabled login methods and lastLoginProvider.
- authentication and security metadata supplied by Payload.

### Auth Identities private collection

- local user relationship.
- provider and issuer; Xero is the only external provider in V1.
- immutable provider subject (`sub`) as the durable identity key.
- last-seen provider email/name snapshots for display and diagnostics only.
- linkedAt, linkedBy, lastUsedAt, status, and unlink/recovery metadata.
- unique provider/issuer/subject and unique user/provider constraints.
- no Xero access token, refresh token, accounting scope, tenant ID, or connection ID.

### Invitations private collection

- normalized invited email and intended local role.
- setup-token hash, expiresAt, acceptedAt, revokedAt, and single-use status.
- createdBy, acceptedBy user, acceptance provider, resend lineage, and safe audit metadata.
- no plaintext setup token and no Xero token or subject before successful acceptance.

### External Auth Sessions private collection

- local user and Auth Identity relationships.
- hashed opaque session token and rotation/version metadata.
- createdAt, expiresAt, lastSeenAt, revokedAt, and revocation reason.
- minimal safe device/session metadata for account security views.
- no Xero ID token or access token; those are discarded after callback validation.

### OAuth Flow States private collection

- flow family: Xero identity or Xero accounting.
- purpose: sign-in, invite acceptance, identity link, accounting connect, reconnect, or authorizer handover.
- hashed state, nonce binding, PKCE material where used, initiating browser/session, and allow-listed return path.
- initiating user and/or invitation relationship where applicable.
- intended pinned tenant for accounting reconnect/handover.
- short expiresAt, consumedAt, and single-use/replay metadata with TTL cleanup.

### Business Settings global

- businessName.
- defaultTimezone.
- baseCurrency.
- locale and display formats.
- support contact details.

### Authentication Settings global

- xeroIdentityLoginEnabled independent of accounting/export controls.
- optional rollout roles/groups for staged enablement.
- xeroIdentityLinkingEnabled and invite-acceptance behavior.
- external-session idle/absolute lifetime and session-display policy.
- optional threshold for enqueueing a stale accounting-health check after login.
- safeguards that preserve email/password and the final owner's recovery path.

### Billing Settings global

- default Xero revenue account code.
- default Xero tax type.
- line amount type.
- default payment terms.
- invoice reference prefix.
- invoice line description template.
- xeroExportMode: background or wait-for-result.
- allowBillerModeOverride, default false.
- optional operational thresholds for forcing large exports into background mode.

### Customers collection

- local display name and active/archive state.
- billing email and optional notes.
- currency.
- Xero ContactID, contact name snapshot, and last validation time.
- mapping status: unmapped, active, archived, invalid, or needs-review.
- optional customer-level billing overrides.

### Projects collection

- customer relationship.
- name, code, description, active/archive state.
- default hourly rate stored as a scaled integer.
- currency.
- billable default.
- optional line-description prefix.

### Time Entries collection

- user and project relationships.
- denormalized customer identifier for efficient filtering and integrity checks.
- inputMode: range or duration.
- workDate as a calendar date.
- timezone snapshot.
- startAt and endAt for range entries.
- durationSeconds as the canonical duration.
- description.
- billable.
- rateSnapshotScaled and currency snapshot.
- billingStatus: unbilled, reserved, or exported.
- currentExport relationship when reserved or exported.
- createdBy, updatedBy, createdAt, and updatedAt.

### Xero Connection private collection

- singleton key.
- Xero tenant ID, connection ID, and tenant name.
- authorizing Xero user ID, authentication event ID, initiating local owner/admin, and authorization timestamp.
- active accounting credential-lineage version plus safe prior-authorizer/handover metadata.
- granted scopes.
- encrypted access-token and refresh-token envelopes.
- access-token expiry and refresh-token last-used time.
- token version used for optimistic locking.
- connection status and last successful request.
- last reference-data sync and health/error metadata.

### Xero Reference Data private collection

- resource type such as account, tax rate, currency, organisation action, or contact cache.
- Xero identifier and display fields.
- active/archived state.
- fetchedAt and source tenant ID.
- indexes needed for Admin selectors and validation.

### Export Batches collection

- one user export request.
- requestedBy.
- requested mode and actual execution mode.
- selection type: explicit IDs or all matching filter.
- immutable normalized filter snapshot.
- invoice export relationships.
- aggregate counts and totals.

### Invoice Exports collection

- export batch and customer.
- immutable entry selection and invoice payload hash.
- unique application reference, current Xero attempt, and persisted job identifier.
- durable dispatch state/queue-pending marker so a committed export cannot be lost before job creation.
- execution state.
- invoice date, due date, currency, and totals.
- saved request payload with secrets excluded.
- Xero InvoiceID, InvoiceNumber, URL, and remote status.
- retry, reconciliation, and safe error metadata.
- requestedBy and timestamps for every state transition.

### Xero Attempts private collection

- invoice export relationship and monotonically increasing attempt number.
- immutable HTTP method, target operation, payload hash, and Xero idempotency key.
- claim/lease identity and timestamps.
- requestStartedAt, requestMayHaveBeenSent, and completedAt.
- classified result: succeeded, definitely-not-created, retryable-before-send, ambiguous, or manual-review.
- safe HTTP status, Xero correlation ID, rate-limit metadata, and redacted error details.
- replacement-attempt lineage; earlier attempts are never overwritten.

### Xero Webhook Receipts private collection

- durable event/deduplication identity and selected tenant ID.
- resource type/ID, event type, event timestamp, receivedAt, and processedAt.
- processing state, linked job, retry count, and redacted failure metadata.
- minimal notification metadata only; authoritative invoice/contact data is fetched from Xero.

### Invoice Export Entries collection

- invoice export relationship.
- time entry relationship.
- Xero LineItemID when returned.
- immutable work date, project, description, duration, quantity, rate, account, tax, and amount snapshots.
- unique export and time-entry pairing.

### Audit Events collection

- append-only event type.
- actor or machine identity.
- target collection and identifier.
- correlation/export identifier.
- timestamp.
- reason where required.
- safe before/after metadata with secrets redacted.

## 7. State models

### Authentication state

    invitation: pending -> accepted | revoked | expired
    OAuth flow: pending -> consumed | expired
    external session: active -> revoked | expired

- An unknown Xero issuer/subject cannot create a user without a valid bound invitation.
- Email is checked only as an additional first-acceptance constraint; issuer/subject is the durable external identity key.
- One provider subject can link to only one local user, and one local user can link to at most one Xero identity in V1.
- A callback creates a local session only after invite/link intent, active-user status, and unique identity constraints pass.
- Unlink is forbidden if it would remove the user's only usable login or recovery method.
- Identity login/logout/link/unlink cannot change accounting connection state, and accounting connect/disconnect cannot change application sessions.

### Time-entry billing state

    unbilled -> reserved -> exported
        ^           |
        |           +-> unbilled on a definite pre-Xero failure
        |
        +----------- released by an explicit Admin release/rebill action

- An ambiguous Xero result remains reserved.
- Generic CRUD cannot alter billingStatus or currentExport.
- Exported entries cannot be materially edited or deleted.

### Invoice-export state

    preparing
      -> queued
      -> processing
      -> succeeded
      -> retry-wait -> processing
      -> action-required
      -> reconciling -> succeeded | retry-wait | manual-review
      -> cancelled, only before a Xero request begins
      -> released, only through the Admin release/rebill workflow

Remote Xero status is stored separately from local execution state.

- `preparing` is a durable committed state awaiting job attachment; a dispatcher recovers any record left there.
- `manual-review` remains locked and reserved unless a resolution command proves how it should be finalized.
- Every possible Xero mutation is represented by an immutable Xero Attempt before the request begins.

## 8. Definition of done for every work package

A work package is complete only when:

- implementation and generated types are committed;
- access control is enforced server-side, not only hidden in the UI;
- unit and integration tests for its behavior pass;
- relevant end-to-end flows pass;
- error, empty, loading, and permission-denied states are implemented;
- logs contain correlation identifiers and no secrets;
- documentation and environment examples are updated;
- migrations or index changes are repeatable and reviewed;
- accessibility and responsive behavior are checked for new user-facing screens;
- the package-specific acceptance gate is demonstrably satisfied.

## 9. Work-package map

| ID | Work package | Primary dependencies |
| --- | --- | --- |
| WP-00 | Repository and engineering foundation | None |
| WP-01 | Environments, MongoDB Atlas, Vercel, and external services | WP-00 |
| WP-02 | Payload core and database model | WP-00, WP-01 |
| WP-03 | Authentication, Xero sign-in, invitations, roles, and route protection | WP-02 |
| WP-04 | Admin foundation and application settings | WP-02, WP-03 |
| WP-05 | Xero accounting OAuth connection and reference data | WP-01, WP-02, WP-03, WP-04 |
| WP-06 | Customers, Xero contact mapping, projects, and rates | WP-04, WP-05 |
| WP-07 | Manual time-entry domain and member UI | WP-03, WP-06 |
| WP-08 | Billing eligibility, filters, and selection | WP-04, WP-06, WP-07 |
| WP-09 | Invoice preview, snapshots, and reservation | WP-05, WP-08 |
| WP-10 | Xero export execution and Payload jobs | WP-05, WP-09 |
| WP-11 | Reconciliation, webhooks, and remote status | WP-10 |
| WP-12 | Admin release and rebill | WP-11 |
| WP-13 | Security, audit, observability, and operations | Begins at WP-00; closes after WP-12 |
| WP-14 | Full-system verification and CI quality gates | All feature packages |
| WP-15 | Staging, production launch, and handover | WP-13, WP-14 |

## WP-00 — Repository and engineering foundation

Depends on: none

Outcome: A reproducible, secret-safe Payload/Next.js repository with pinned tooling and fast quality checks.

Implementation note (2026-07-18): the deployable Payload/Next.js project lives in `app/`; Vercel must use `app` as its Root Directory. The project currently uses Payload 3.86.0, Next.js 16.2.6, and pnpm 10.28.1.

### Todo

- [ ] Confirm or repair the Git upstream before enabling CI; the current local branch reports its configured origin/main as gone.
- [x] Scaffold from the current supported Payload blank application template.
- [x] Use pnpm and generate the lockfile for inclusion with the setup changes.
- [x] Pin an exact compatible set of Next.js, Payload, and all Payload packages.
- [x] Declare the supported Node.js range in package metadata and document Node.js 24 LTS as the hosted target.
- [ ] Enable strict TypeScript and useful no-unchecked-access options.
- [x] Organize routes into isolated Payload and custom-application route groups.
- [ ] Create source boundaries for:
  - [ ] Payload collections and globals;
  - [ ] access-control helpers;
  - [ ] identity/OIDC and local session services;
  - [ ] domain services;
  - [ ] Xero identity/OIDC client with no retained provider tokens;
  - [ ] Xero accounting client and rotating token service;
  - [ ] jobs and workflows;
  - [ ] custom route handlers;
  - [ ] UI components;
  - [ ] test factories and fixtures.
- [x] Expand .gitignore for dependencies, Next.js output, Payload output, Vercel state, environment files, coverage, Playwright artifacts, logs, local Mongo data, and editor/OS files.
- [x] Add .env.example containing names and descriptions only.
- [ ] Configure linting, formatting, type checking, and import ordering.
- [ ] Add scripts for dev, build, start, lint, typecheck, unit tests, integration tests, end-to-end tests, Payload type generation, import-map generation, migrations, and seed data.
- [x] Add a root README with local prerequisites, setup, commands, and links to this plan.
- [ ] Add a small architecture-decision record directory and record:
  - [ ] Payload as the application framework;
  - [ ] MongoDB instead of Postgres;
  - [ ] single-business boundary;
  - [ ] invite-gated optional Xero sign-in alongside email/password;
  - [ ] separate Xero identity and accounting OAuth clients;
  - [ ] standard Xero accounting OAuth;
  - [ ] persisted export saga;
  - [ ] custom member UI versus generated Admin.
- [x] Configure a test runner and DOM test environment.
- [x] Configure Playwright with isolated test data.
- [ ] Add a pre-commit or pre-push fast check without making local development dependent on an external service.
- [ ] Add a dependency-update policy requiring Payload packages to update together.
- [x] Ensure no secret, local database, or IDE file becomes tracked.

### Verification and acceptance

- [x] A clean checkout installs reproducibly with one documented command.
- [ ] Development server, lint, typecheck, unit tests, and production build succeed.
- [x] Payload Admin and a placeholder custom-app route both render.
- [x] The repository contains no real credentials.

## WP-01 — Environments, MongoDB Atlas, Vercel, and external services

Depends on: WP-00

Outcome: Isolated local, test, staging, and production environments with transaction-capable MongoDB and documented secrets.

### Todo

- [x] Create a local MongoDB replica-set setup; do not use standalone MongoDB for transaction tests.
- [x] Add deterministic local replica-set initialization and a health check.
- [ ] Create separate databases or Atlas projects for development, staging, and production.
- [ ] Provision MongoDB Atlas Flex or better for production so backups are available.
- [ ] Select an Atlas region close to the chosen Vercel function region.
- [ ] Create least-privilege application database users instead of retaining a broad Marketplace-generated administrator.
- [ ] Configure TLS and Atlas network access.
- [ ] Document the Vercel dynamic-egress trade-off and choose either:
  - [ ] restricted static egress where available; or
  - [ ] broad network allow-list with strong least-privilege credentials and monitoring.
- [ ] Set a conservative Mongoose pool configuration suitable for serverless instances.
- [ ] Configure Atlas alerts for connections, storage, replication, and availability.
- [ ] Configure and test backup retention and a restore procedure.
- [ ] Create Vercel staging and production projects or environments on the Pro plan.
- [ ] Select and document the Vercel function region.
- [ ] Configure a stable staging hostname and production hostname.
- [ ] Create distinct Xero identity and accounting app/client registrations for each hosted environment; never reuse one client ID across the two trust boundaries.
- [ ] Connect the development application to a Xero Demo Company.
- [ ] Register separate exact identity and accounting OAuth callback URLs; do not use wildcard or shared callbacks.
- [ ] Reserve the Xero webhook URLs for staging and production.
- [ ] Select and configure an email delivery service for invitations, verification, and password reset.
- [ ] Define environment variables:
  - [x] DATABASE_URL;
  - [x] PAYLOAD_SECRET;
  - [x] TOKEN_ENCRYPTION_KEY and key version;
  - [x] AUTH_FLOW_ENCRYPTION_KEY and key version;
  - [x] NEXT_PUBLIC_SERVER_URL or equivalent public origin;
  - [x] XERO_IDENTITY_CLIENT_ID;
  - [x] XERO_IDENTITY_CLIENT_SECRET;
  - [x] XERO_IDENTITY_REDIRECT_URI;
  - [x] XERO_ACCOUNTING_CLIENT_ID;
  - [x] XERO_ACCOUNTING_CLIENT_SECRET;
  - [x] XERO_ACCOUNTING_REDIRECT_URI;
  - [x] XERO_WEBHOOK_KEY;
  - [x] CRON_SECRET;
  - [ ] email provider credentials;
  - [ ] error-monitoring credentials;
  - [ ] optional seed-owner variables for initial provisioning.
- [ ] Set different secret values in every environment.
- [ ] Validate at startup that identity and accounting client IDs, secrets, and callbacks are not accidentally equal.
- [ ] Document secret generation, rotation, revocation, and emergency replacement.
- [ ] Ensure preview deployments cannot reach or migrate production data by default.

### Verification and acceptance

- [ ] Local and CI integration tests successfully commit and roll back a multi-document transaction.
- [ ] Staging connects to its own Atlas data and Xero Demo Company.
- [ ] Staging identity and accounting callbacks use different Xero client IDs/routes and cannot consume each other's OAuth state.
- [ ] Production configuration is isolated and contains no demo credentials.
- [ ] A documented backup restore is tested against a non-production database.
- [ ] Vercel can build without exposing secret values to client bundles or logs.

## WP-02 — Payload core and database model

Depends on: WP-00, WP-01

Outcome: Payload collections, globals, generated types, MongoDB indexes, and transaction helpers reflect the agreed domain.

### Todo

- [ ] Configure Payload with mongooseAdapter and the environment-specific MongoDB URL.
- [ ] Configure safe Mongoose connection and transaction options.
- [ ] Configure the Payload secret and canonical server URL.
- [ ] Disable GraphQL if it is not used by the custom application.
- [ ] Set conservative REST depth and pagination defaults.
- [ ] Implement the Users collection.
- [ ] Implement the private Invitations, Auth Identities, External Auth Sessions, and OAuth Flow States collections.
- [ ] Implement Business Settings, Authentication Settings, and Billing Settings globals.
- [ ] Implement Customers, Projects, and Time Entries collections.
- [ ] Implement the private Xero Connection and Xero Reference Data collections.
- [ ] Implement Export Batches, Invoice Exports, Invoice Export Entries, Xero Attempts, Xero Webhook Receipts, and Audit Events.
- [ ] Add field-level validation for enums, scaled integers, ISO currency codes, IANA timezones, dates, and identifiers.
- [ ] Add automatic createdBy and updatedBy attribution where appropriate.
- [ ] Mark system-owned fields inaccessible to ordinary create/update APIs.
- [ ] Hide encrypted token envelopes and internal error data from Payload Admin and public REST responses.
- [ ] Hide auth-session hashes, OAuth state/nonce/PKCE material, provider subjects, and identity diagnostic metadata from ordinary APIs.
- [ ] Configure Admin labels, title fields, list columns, default sorting, and grouping.
- [ ] Add compound and query indexes for:
  - [ ] users by email and role;
  - [ ] unique invitation token hash plus email/status/expiry lookup;
  - [ ] unique Auth Identity provider/issuer/subject;
  - [ ] unique Auth Identity user/provider;
  - [ ] external auth sessions by token hash, user, expiry, and revoked state;
  - [ ] unique OAuth state hash plus expiresAt/consumedAt TTL and replay lookup;
  - [ ] customers by active state, local name, and Xero ContactID;
  - [ ] projects by customer, active state, and code;
  - [ ] time entries by user/workDate;
  - [ ] time entries by project/workDate;
  - [ ] time entries by billingStatus, billable, customer, and workDate;
  - [ ] export batches by requestedBy and createdAt;
  - [ ] invoice exports by state and createdAt;
  - [ ] invoice exports by dispatch state, missing job ID, and age;
  - [ ] unique application reference;
  - [ ] unique Xero attempt number per invoice export;
  - [ ] unique Xero idempotency key across attempts;
  - [ ] sparse unique Xero InvoiceID where present;
  - [ ] unique export/time-entry allocation;
  - [ ] unique webhook event/deduplication identity and pending-receipt age.
- [ ] Add custom Mongo index migrations where Payload config cannot express a partial or sparse invariant.
- [ ] Add schemaVersion to immutable export snapshots.
- [ ] Create wrappers for Payload Local API calls that:
  - [ ] default user-context calls to overrideAccess false;
  - [ ] require an explicit reason to elevate system operations;
  - [ ] propagate the same request/session through transaction-bound calls.
- [ ] Create transaction helpers with clear commit/rollback semantics.
- [ ] Add data factories for every collection.
- [ ] Add transaction tests proving invite acceptance, identity linking, user activation, and state consumption commit or roll back together.
- [ ] Generate and commit Payload TypeScript types and the Admin import map.
- [ ] Create an idempotent seed routine for the initial owner and baseline settings.
- [ ] Create migration conventions even though routine Mongo field additions do not require DDL.

### Verification and acceptance

- [ ] All collections and globals are available with correct generated types.
- [ ] Required unique and query indexes exist in local and staging MongoDB.
- [ ] Invitation, identity, session, and OAuth-state unique/TTL indexes enforce single use and cleanup.
- [ ] A deliberately failed multi-collection write rolls back completely.
- [ ] Sensitive fields cannot be returned through ordinary REST or Admin queries.
- [ ] Identity records contain no accounting credentials or tenant connection fields.
- [ ] The seed routine can run twice without duplicating data.

## WP-03 — Authentication, Xero sign-in, invitations, roles, and route protection

Depends on: WP-02

Outcome: Invite-only local authentication supports email/password and optional Xero sign-in while keeping identity separate from accounting authority and excluding time-entry users from Admin.

### Email/password and invitation todo

- [ ] Keep Payload's built-in email/password strategy enabled alongside the external Xero strategy.
- [ ] Use secure HTTP-only authentication cookies and configure secure, same-site behavior for staging and production.
- [ ] Enable email verification, password reset, login-attempt limits, and timed lockout.
- [ ] Disable public user creation and every self-registration endpoint regardless of login provider.
- [ ] Implement one-time owner bootstrap with a tested email/password recovery path.
- [ ] Ensure at least one active owner always retains a non-Xero recovery method.
- [ ] Implement Admin-driven invitations:
  - [ ] create an inactive or pending local user with the locally assigned role;
  - [ ] generate and store only a hash of a single-use expiring setup token;
  - [ ] send a branded invitation email;
  - [ ] allow acceptance by email/password or by the Xero identity flow;
  - [ ] activate the user only after the chosen flow succeeds;
  - [ ] invalidate the token atomically after use;
  - [ ] support safe resend and revoke.
- [ ] For Xero-based invite acceptance, require both the valid invitation context and the Xero callback; matching email alone is never sufficient.
- [ ] Require the normalized invited email to match the verified Xero email, or stop for explicit owner/admin review rather than silently changing the invitation.
- [ ] Assign the user's role, active state, and business membership exclusively from the local invitation/Admin action.
- [ ] Add display name, role, active state, timezone, enabled login methods, and last login provider to the user profile.
- [ ] Default a new user's timezone from Business Settings while allowing later selection.
- [ ] Prevent users from changing their own role or active state.
- [ ] Prevent suspension, demotion, deletion, or removal of the recovery method of the final active owner, including under concurrent requests.
- [ ] Ensure password reset and invitation responses do not reveal whether an arbitrary email address exists.

### Xero identity sign-in todo

- [ ] Use only the dedicated Xero identity client registration and callback for sign-in.
- [ ] Request exactly `openid profile email`; reject configuration containing `offline_access`, accounting scopes, or any tenant-scoped permission.
- [ ] Use a maintained OpenID Connect client and Xero discovery/JWKS metadata rather than implementing token verification ad hoc.
- [ ] Add a correctly branded “Sign in with Xero” action to login and eligible invitation pages.
- [ ] Implement a Xero identity start endpoint that:
  - [ ] records whether the purpose is sign-in, invite acceptance, or link;
  - [ ] generates high-entropy state and nonce values;
  - [ ] binds the flow to the initiating browser, local session/invitation, and allow-listed return path;
  - [ ] uses PKCE when supported by the selected client/flow;
  - [ ] stores sensitive verifier material safely;
  - [ ] sets a short expiry and single-use state.
- [ ] Implement the identity callback that:
  - [ ] rejects OAuth errors with a safe user-facing result;
  - [ ] validates state, browser binding, purpose, expiry, and one-time use before account changes;
  - [ ] exchanges the authorization code only on the server;
  - [ ] validates ID-token signature, issuer, audience, expiry, issued-at, nonce, and required claims;
  - [ ] reads the stable issuer/subject pair plus email/name display claims;
  - [ ] marks state consumed atomically to prevent replay;
  - [ ] rejects unknown, extra, or accounting scopes;
  - [ ] discards the authorization code, ID token, and identity access token after validation.
- [ ] Never request or store an identity refresh token.
- [ ] Never call the Xero Connections or Accounting APIs from an identity callback.
- [ ] Resolve returning users by unique issuer/subject, not by email.
- [ ] Recheck the local user's active state and current role before creating a session.
- [ ] Deny an unknown/uninvited Xero subject without revealing whether the email belongs to an existing account.
- [ ] Do not create, merge, move, or link an account merely because a Xero email matches a local email.
- [ ] Do not automatically replace the authoritative local email/name when Xero claims change; show the snapshot for explicit profile review.
- [ ] Make Xero login optional and keep the email/password entry point available when Xero is unavailable or the feature is disabled.

### Identity linking and local session todo

- [ ] Run an implementation spike proving the selected Payload custom strategy and local session design before completing the remaining Xero sign-in UI.
- [ ] Implement a Payload custom authentication strategy that validates a hashed opaque External Auth Session and returns the current local user.
- [ ] Issue and rotate a local application session only after the Xero callback and local-account checks succeed.
- [ ] Never use a Xero ID token or access token as the application's browser session.
- [ ] Store only a hash of the opaque external session token and send the raw value only in a secure HTTP-only cookie.
- [ ] Define idle/absolute expiry, rotation, revocation, device display, and cleanup behavior for external sessions.
- [ ] Apply the same CSRF, origin, cookie, and session-fixation protections to both login methods.
- [ ] Build an account-security page listing enabled login methods, linked Xero identity display data, and active local sessions without exposing provider subject or token data.
- [ ] Require a recently authenticated local session before linking Xero to an existing user.
- [ ] Require explicit confirmation and enforce unique issuer/subject and one-Xero-identity-per-user constraints.
- [ ] Never silently transfer a Xero identity between local users; provide a reasoned, audited owner recovery process for genuine collisions.
- [ ] Permit unlink only when another usable login/recovery method remains, and require recent authentication plus confirmation.
- [ ] Do not log the user out of Xero or disconnect the business accounting integration when logging out or unlinking locally.
- [ ] Revoke both Payload and External Auth Sessions on suspension, global logout, credential compromise, or relevant security recovery.
- [ ] Add a custom account page for password, display name, timezone, Xero link/unlink, and session management.
- [ ] Document an audited recovery procedure for loss of access to the only owner account and for a compromised external identity link.
- [ ] Audit invitation, acceptance provider, identity link/unlink/collision/recovery, login provider, role change, deactivation, password reset, and session revocation without storing tokens.
- [ ] Rate-limit email login, Xero start/callback failures, forgot-password, reset, invite acceptance, verification, link, and unlink operations.
- [ ] After a successful login, optionally enqueue a non-blocking stale accounting-connection health check that uses only the existing server-held accounting credential.
- [ ] Ensure the health check can neither delay nor fail login and receives no identity-flow token or code.

### Authorization and route-protection todo

- [ ] Add authorization helpers that fail closed for unknown roles and operate identically for both login methods.
- [ ] Deny Payload Admin to member and biller roles.
- [ ] Permit Payload Admin only to owner and admin.
- [ ] Protect custom application route groups by local authentication.
- [ ] Protect billing routes to owner, admin, and biller.
- [ ] Protect settings, accounting connection, identity recovery, and release/rebill actions to the appropriate local owner/admin capability.
- [ ] Ensure local roles—not Xero claims, Xero organisation permissions, or accounting authorizer identity—control every route and field.
- [ ] Ensure deactivated users lose new sessions and cannot refresh existing sessions through either provider.

### Verification and acceptance

- [ ] Owner/admin can invite and deactivate users; an invitation can be accepted by email/password or the bound Xero flow.
- [ ] An uninvited Xero user cannot register, and matching email alone cannot link or take over an account.
- [ ] A returning user is resolved by issuer/subject and receives the same local role regardless of current Xero email or organisation access.
- [ ] Identity login requests only identity scopes and persists no Xero identity token.
- [ ] Xero sign-in cannot read or mutate the business tenant, accounting tokens, scopes, connection health, or export state.
- [ ] State/nonce/code replay, wrong browser, wrong purpose, wrong issuer/audience, expiry, email mismatch, duplicate subject, collision, and open-redirect tests pass.
- [ ] Session fixation, rotation, expiry, unlink, suspension, role change, and global-revocation tests pass for both login methods.
- [ ] Email/password login remains operational when Xero sign-in is disabled or unavailable.
- [ ] A member can use either login method but receives no Payload Admin or financial access.
- [ ] A biller can access billing screens but receives no Payload Admin access.
- [ ] Members cannot read rates, billing settings, export records, Xero data, or other users' time.

## WP-04 — Admin foundation and application settings

Depends on: WP-02, WP-03

Outcome: Owner/admin users can safely configure the business and billing behavior without gaining generic access to protected system state.

### Todo

- [ ] Brand the Payload Admin and provide navigation groups for People, Customers, Projects, Billing, Xero, and Operations.
- [ ] Hide internal Payload job and protected system collections unless a diagnostic view explicitly exposes safe fields.
- [ ] On user detail, show safe login-method status, last login provider/time, linked-Xero display name/email snapshot, and active local-session count.
- [ ] Do not expose raw provider subject, OAuth state/nonce/verifier, authorization code, ID/access token, session token/hash, or accounting credential in Admin.
- [ ] Add owner/admin controls to revoke a linked identity or user sessions only through the protected WP-03 recovery commands with confirmation and audit reason.
- [ ] Use unambiguous UI labels: “Sign in/link with Xero” for identity and “Connect/Reconnect Xero organisation” for accounting.
- [ ] Show identity-login health separately from accounting-connection health so an incident in one is not presented as failure of the other.
- [ ] Configure Business Settings fields:
  - [ ] business name;
  - [ ] default timezone;
  - [ ] base currency;
  - [ ] locale/date/time display preferences.
- [ ] Configure Authentication Settings fields:
  - [ ] independent Xero identity-login feature flag;
  - [ ] staged rollout roles/groups;
  - [ ] identity-linking and invite-acceptance switches;
  - [ ] external-session lifetime;
  - [ ] stale accounting-health-check threshold.
- [ ] Prevent authentication settings from disabling email/password or the final owner's tested recovery path.
- [ ] Configure Billing Settings fields:
  - [ ] default revenue account;
  - [ ] default tax type;
  - [ ] line amount type;
  - [ ] due-date terms;
  - [ ] reference prefix;
  - [ ] line-description template;
  - [ ] background versus wait-for-result execution;
  - [ ] allow biller override, default false;
  - [ ] size threshold that forces background execution.
- [ ] Label the synchronous mode “Wait for Xero,” not “instant.”
- [ ] Explain in Admin help text that both modes use the same durable job and that wait mode may continue in the background.
- [ ] Make export-mode changes apply only to future export batches.
- [ ] Validate account/tax selections against the currently connected Xero tenant once reference data is available.
- [ ] Prevent configuration changes from rewriting historical Time Entry or Invoice Export snapshots.
- [ ] Add safe defaults while leaving Xero-dependent settings visibly incomplete until connection.
- [ ] Add an Admin dashboard showing:
  - [ ] active users;
  - [ ] unmapped customers;
  - [ ] unbilled entry count;
  - [ ] Xero connection health;
  - [ ] queued/action-required/manual-review export counts.
- [ ] Add audit events for every business, billing, role, and execution-mode setting change.
- [ ] Add confirmation for high-impact settings and display the actor and last-change timestamp.

### Verification and acceptance

- [ ] Only owner/admin can change settings.
- [ ] Xero identity sign-in can be independently disabled without changing accounting settings or existing export processing.
- [ ] A settings change affects new previews but not saved export snapshots.
- [ ] Invalid Xero settings block export with an actionable message.
- [ ] The Admin dashboard contains no tokens or sensitive payloads.
- [ ] Identity/session recovery controls cannot mutate the business Xero Connection.

## WP-05 — Xero accounting OAuth connection and reference data

Depends on: WP-01, WP-02, WP-03, WP-04

Outcome: A secure, maintainable business accounting grant connects exactly one pinned Xero organisation, refreshes independently of user login, and supports controlled authorizer handover.

### Accounting client and initial connection todo

- [ ] Use only the dedicated Xero accounting client registration, secret, and callback for this package.
- [ ] Register the minimum required accounting scopes:
  - [ ] offline_access;
  - [ ] accounting.invoices;
  - [ ] accounting.contacts because explicit contact creation is supported;
  - [ ] accounting.settings.read.
- [ ] Do not request `openid`, `profile`, `email`, or other identity scopes from the accounting client.
- [ ] Ensure the accounting callback never creates an application user, links an Auth Identity, or creates/revokes an application session.
- [ ] Ensure the identity callback cannot read or write Xero Connection, call the Connections API, select a tenant, or invoke the accounting token service.
- [ ] Use the standard Authorization Code connection; do not use Xero Custom Connections.
- [ ] Reconfirm Xero's current developer-app pricing and connection allowance before staging and production launch.
- [ ] Implement an owner/admin-only “Connect Xero organisation” action requiring a recent local authentication check.
- [ ] Generate high-entropy accounting OAuth state in OAuth Flow States, bind it to the initiating user/session and operation, set a short expiry, and enforce one-time use.
- [ ] Build the authorization URL using the exact accounting callback and reject the identity callback path.
- [ ] Implement the accounting callback:
  - [ ] validate flow family, purpose, state, session binding, expiry, and one-time use before exchanging the code;
  - [ ] exchange the authorization code server-side with the accounting client only;
  - [ ] validate the exact granted accounting scopes;
  - [ ] identify the authorizing Xero user/authentication event from validated token claims;
  - [ ] fetch connections for the current authentication event;
  - [ ] let owner/admin explicitly select the intended organisation if several were authorized;
  - [ ] on first connection, persist and pin tenant/connection identity;
  - [ ] encrypt tokens before persistence;
  - [ ] record local initiator, Xero authorizer, authentication event, scopes, and expiry;
  - [ ] consume and clean temporary OAuth state.
- [ ] Reject a callback that arrives at the wrong flow handler even when its state/code shape otherwise appears valid.
- [ ] Treat accounting credentials as business integration credentials, not as login credentials or ownership of the local user account.

### Accounting token lifecycle todo

- [ ] Encrypt accounting tokens with a dedicated versioned authenticated-encryption key, separate from PAYLOAD_SECRET and external-auth session storage.
- [ ] Never decrypt tokens in a broad afterRead hook.
- [ ] Implement a narrow server-only accounting token service that cannot be imported by identity/authentication routes.
- [ ] Serialize rotating refresh-token use with an optimistic version or connection-level lock.
- [ ] Persist both new access and refresh tokens atomically after refresh.
- [ ] Support the documented old-token grace path when a refresh response is uncertain.
- [ ] Refresh before an accounting API call whenever the access token is near expiry.
- [ ] Schedule a low-frequency proactive refresh/health check well before the refresh token's inactivity limit even when no exports occur.
- [ ] Allow a successful application login to enqueue that same health check only when stale, using the existing encrypted accounting grant.
- [ ] Make the login-triggered health check asynchronous, best-effort, deduplicated, and unable to affect login success or latency.
- [ ] Never pass an identity authorization code, ID token, access token, subject, or identity-flow state into an accounting refresh job.
- [ ] Alert and show reauthorization-required state after a terminal refresh failure without deleting historical mappings.

### Disconnect, reconnect, and authorizer-handover todo

- [ ] Implement safe owner/admin disconnect:
  - [ ] block or require resolution while an export has an ambiguous Xero outcome;
  - [ ] revoke/delete the remote accounting connection where appropriate;
  - [ ] retain tenant identity and historical invoice mappings;
  - [ ] clear usable accounting credentials;
  - [ ] mark the connection disconnected;
  - [ ] audit the actor and reason.
- [ ] Ensure accounting disconnect/reconnect never revokes Auth Identities or application sessions.
- [ ] Ensure local logout, Xero identity unlink, or identity-client revocation never changes accounting connection state.
- [ ] Implement reconnect against the already pinned tenant ID.
- [ ] Require exact pinned-tenant match; never select the first returned organisation or silently switch tenants.
- [ ] Treat authorization by a different Xero user as an explicit accounting-authorizer handover.
- [ ] For handover:
  - [ ] require owner/admin capability, recent local reauthentication, a reason, and high-impact confirmation;
  - [ ] block cutover while exports have unresolved ambiguous outcomes;
  - [ ] validate new scopes, tenant, organisation capability, and connection health before changing the active credential;
  - [ ] keep the old credential active until validation succeeds;
  - [ ] atomically switch the credential-lineage version and provenance;
  - [ ] retain safe old/new authorizer and connection lineage in audit history;
  - [ ] revoke the obsolete credential/connection only after verified cutover.
- [ ] Abort and retain the working connection when validation, tenant match, or atomic cutover fails.
- [ ] Warn operators when the local account associated with the current accounting authorizer is suspended or scheduled to leave, without silently disconnecting Xero.
- [ ] Nominate and document a backup owner/admin capable of controlled reauthorization before launch.
- [ ] Block silent switching to another tenant; a future intentional tenant migration requires a separate scoped plan and mapping remediation.

### Reference-data and Admin todo

- [ ] Fetch Organisation and Organisation Actions after connection.
- [ ] Verify CreateDraftInvoice permission and supported organisation plan.
- [ ] Fetch and cache active accounts, tax rates, currencies, and other fields needed for invoice configuration.
- [ ] Filter the account selector to appropriate active revenue/sales accounts.
- [ ] Refresh reference data:
  - [ ] after connection or handover;
  - [ ] on demand from Admin;
  - [ ] on a safe periodic schedule;
  - [ ] after mapping validation failures.
- [ ] Add an Admin accounting-connection page showing tenant name/ID, connection status, accounting scopes, Xero authorizer display/ID, local initiator, authorization date, last refresh, last API success, and reconnect/disconnect/handover actions.
- [ ] Keep Xero sign-in status on the identity/user screens rather than conflating it with accounting connection health.
- [ ] Redact all accounting and identity tokens, authorization codes, state/nonce values, client secrets, and provider subjects from logs, errors, traces, Admin, and audit payloads.
- [ ] Wrap the Xero Accounting SDK or HTTP client behind an application interface so tests do not depend on live Xero.
- [ ] Confirm SDK examples use current granular scopes rather than deprecated broad scopes.

### Verification and acceptance

- [ ] Local/staging completes accounting authorization against the Xero Demo Company using the accounting client only.
- [ ] Accounting state replay, wrong-flow callback, wrong session, expiry, wrong tenant, missing scopes, and callback errors are rejected safely.
- [ ] Concurrent simulated API calls cannot corrupt rotating refresh tokens.
- [ ] A same-authorizer reconnect and different-authorizer handover both preserve the pinned tenant and historical records.
- [ ] A failed or wrong-tenant handover leaves the previous working accounting credential active and unchanged.
- [ ] Xero identity sign-in, logout, link, and unlink leave accounting tenant, scopes, connection, token ciphertext, and export state unchanged.
- [ ] Accounting connect, disconnect, reconnect, and handover leave local users, Auth Identities, and application sessions unchanged.
- [ ] A login-triggered health check uses only the stored accounting credential and cannot fail or delay login.
- [ ] Account, tax, currency, and organisation capability data appears in Admin.
- [ ] Disconnect removes usable accounting access but preserves historical export records.
- [ ] No credential, provider subject, or authorization artifact appears in client code, logs, Admin JSON, or error monitoring.

## WP-06 — Customers, Xero contact mapping, projects, and rates

Depends on: WP-04, WP-05

Outcome: Privileged users can manage local customers/projects, select contacts already created in Xero, explicitly create missing contacts, and maintain stable project billing rates.

### Customer and contact todo

- [ ] Implement local customer create, edit, archive, and search flows in Payload Admin.
- [ ] Prefer archive over deletion.
- [ ] Block deletion when a project, time entry, export, or audit event references the customer.
- [ ] Permit an unmapped local customer to have projects and time entries, but block invoice export until mapping is valid.
- [ ] Add a sparse unique index on Xero ContactID so a Xero contact cannot map to two local customers.
- [ ] Keep local editable fields separate from Xero snapshot fields so synchronisation cannot overwrite local notes or naming unexpectedly.
- [ ] Build a server-only Xero contact search service with pagination and bounded queries.
- [ ] Add an owner/admin “Select from Xero” interface.
- [ ] Show contact name, email, contact number, active/archive state, and existing local mapping.
- [ ] Support “Import as new customer” from a selected Xero contact.
- [ ] Support “Link this customer” for an existing unmapped local customer.
- [ ] Detect an already-linked ContactID and link to the existing local record from the validation message.
- [ ] Add an explicit owner/admin “Create contact in Xero” action:
  - [ ] validate required local customer fields;
  - [ ] preview the exact contact payload;
  - [ ] require confirmation;
  - [ ] persist an application idempotency/reference record;
  - [ ] create the contact server-side;
  - [ ] store the returned ContactID atomically;
  - [ ] reconcile an uncertain timeout before retrying.
- [ ] Do not create Xero contacts implicitly during invoice export.
- [ ] Add manual contact refresh and periodic lightweight status refresh.
- [ ] Detect archived, merged, missing, or inaccessible Xero contacts.
- [ ] Never remap a contact by matching its name.
- [ ] Add a guarded “Change Xero link” action with a mandatory reason and warning when historical invoices exist.
- [ ] Display mapping state badges and actionable errors in customer lists/forms.
- [ ] Restrict all Xero contact search/create/remap operations to owner/admin.

### Project and rate todo

- [ ] Implement local project create, edit, archive, and search flows.
- [ ] Require a customer relationship, name, currency, and non-negative hourly rate.
- [ ] Store hourly rate as a scaled integer supporting the agreed Xero precision.
- [ ] Format scaled rates safely in Admin without binary floating-point calculations.
- [ ] Validate project currency against customer currency.
- [ ] Define project-code normalization and uniqueness.
- [ ] Allow optional project overrides for revenue account, tax type, and Xero tracking values.
- [ ] Display inherited versus overridden settings clearly.
- [ ] Snapshot the project rate, currency, project name/code, and customer onto each new time entry.
- [ ] Make the time-entry rate snapshot invisible to members.
- [ ] Make later project rate changes affect only newly created entries by default.
- [ ] Add an explicit owner/admin action to recalculate selected unbilled entries when a commercial rate change should apply retrospectively.
- [ ] Preview the affected count/value and require confirmation before recalculation.
- [ ] Never recalculate reserved or exported entries.
- [ ] Warn before rate/currency/account/tax changes when unbilled entries exist.
- [ ] Disallow a project currency change once referenced by time; require a new project or controlled migration.
- [ ] Prevent archived projects from being selected for new time while keeping historical entries billable and readable.
- [ ] Block deletion of referenced projects.
- [ ] Audit customer mapping, customer status, project status, rate, currency, account, tax, and tracking changes.

### Verification and acceptance

- [ ] Owner/admin can import a contact already created in Xero.
- [ ] Owner/admin can link an existing local customer or explicitly create a missing Xero contact.
- [ ] Duplicate or name-based contact mappings cannot occur silently.
- [ ] Members cannot search Xero or view/change mappings and rates.
- [ ] Project-rate parsing, scaled arithmetic, and display-format tests pass.
- [ ] Rate changes never rewrite reserved/exported data or historical export snapshots.
- [ ] Archived projects remain visible historically but cannot receive new entries.

## WP-07 — Manual time-entry domain and member UI

Depends on: WP-03, WP-06

Outcome: Members can record completed work either as a local start/finish range or as hours/minutes, with no running timer.

### Domain and validation todo

- [ ] Implement exactly two input modes: range and duration.
- [ ] Use minute precision throughout V1; reject seconds and fractional minutes.
- [ ] For range mode require:
  - [ ] work date;
  - [ ] timezone;
  - [ ] local start time;
  - [ ] local finish time or explicit next-day finish.
- [ ] Convert local times to unambiguous UTC instants using a timezone-aware library.
- [ ] Calculate duration from resolved instants, not by subtracting local clock strings.
- [ ] Derive workDate from the start in the entry timezone.
- [ ] Support an interval crossing midnight through an explicit next-day/end-date control.
- [ ] Reject nonexistent daylight-saving local times.
- [ ] When a local time occurs twice, require the intended UTC offset rather than guessing.
- [ ] For duration mode require:
  - [ ] work date;
  - [ ] timezone;
  - [ ] whole hours and minutes;
  - [ ] no start/end timestamps.
- [ ] Convert both modes to canonical positive durationSeconds divisible by 60.
- [ ] Define and enforce a sensible maximum duration per entry.
- [ ] Require a project and a non-empty description for billable entries.
- [ ] Derive customer from the selected project and validate it server-side.
- [ ] Default billable from the project while allowing the member to change it.
- [ ] Snapshot user timezone, project/customer identity, currency, and current project rate on create.
- [ ] Preserve an entry's timezone snapshot when the user later changes preference.
- [ ] Detect likely duplicate and overlapping range entries and show a warning; do not silently discard input.
- [ ] Allow members to create, update, duplicate, and delete only their own unbilled entries.
- [ ] Allow owner/admin to correct unbilled entries with an audit reason.
- [ ] Prevent all generic edits/deletes of reserved or exported entries.
- [ ] Prevent clients from writing derived customer, rate, billingStatus, or currentExport fields.
- [ ] Audit privileged corrections and deletion.

### Custom application todo

- [ ] Build a custom authenticated application shell separate from Payload Admin.
- [ ] Route members to the time-entry area after login.
- [ ] Build the time-entry form with a clear “Start and finish” versus “Hours and minutes” switch.
- [ ] Default timezone from the user profile.
- [ ] Provide a searchable IANA timezone selector for the profile and each entry.
- [ ] Display the current UTC offset, especially around daylight-saving changes.
- [ ] Build active customer/project selectors with the customer derived from project.
- [ ] Show calculated duration before saving a range entry.
- [ ] Preserve form data and focus when server validation fails.
- [ ] Build daily and weekly views.
- [ ] Show date, customer, project, description, input mode, duration, billable state, and billing state.
- [ ] Add date, customer, project, billable, and billing-state filters.
- [ ] Display daily/weekly duration totals without exposing rates to members.
- [ ] Add edit, duplicate, and delete actions only when allowed.
- [ ] Explain why a reserved/exported entry is locked.
- [ ] Link privileged users from a locked entry to its export record.
- [ ] Make the primary entry/list flows usable with keyboard, mobile, and desktop.
- [ ] Add complete loading, empty, offline/network-error, permission, and expired-session states.
- [ ] Do not implement start, stop, pause, elapsed-time polling, or any running-timer endpoint in V1.

### Verification and acceptance

- [ ] Unit tests cover ordinary, cross-midnight, DST-gap, and repeated-time range calculations.
- [ ] Duration-mode validation and conversion tests cover boundary values.
- [ ] A profile timezone change leaves existing entries unchanged.
- [ ] Customer/project consistency is enforced through UI, REST, and Local API.
- [ ] Members cannot create time for another user or alter another user's entry.
- [ ] Reserved/exported entries cannot be changed by generic APIs.
- [ ] End-to-end tests cover both input modes, validation recovery, timezone selection, filtering, duplication, editing, and deletion.
- [ ] Source and UI contain no running-timer behavior.

## WP-08 — Billing eligibility, filters, and selection

Depends on: WP-04, WP-06, WP-07

Outcome: Biller/admin/owner can select explicit entries or all eligible unbilled entries matching an optional filter, with exact totals and visible blockers.

### Eligibility todo

- [ ] Implement one shared server-side eligibility service used by count, list, preview, and confirmation.
- [ ] Define an eligible entry as:
  - [ ] billable;
  - [ ] unbilled;
  - [ ] positive whole-minute duration;
  - [ ] valid project/customer relationship;
  - [ ] positive rate and valid currency snapshot;
  - [ ] valid active Xero contact mapping;
  - [ ] resolvable revenue account, tax type, and required tracking;
  - [ ] not already reserved by another export.
- [ ] Keep historical entries eligible when the source project/customer is archived, provided financial mappings remain valid.
- [ ] Return structured blocker codes and remediation links.
- [ ] Cover at least unmapped/archived contact, missing rate, currency conflict, missing account/tax/tracking, invalid duration, stale source data, and active reservation.
- [ ] Apply deterministic ordering by customer, currency, workDate, project, user, and entry ID.
- [ ] Calculate totals with integer/scaled arithmetic.
- [ ] Never expose rate/amount data to members.

### Selection todo

- [ ] Support explicit selected time-entry IDs.
- [ ] Support all eligible entries matching a normalized filter, with explicit exclusions.
- [ ] Permit an explicit unfiltered “all eligible unbilled” selection; show its full count, oldest/newest dates, totals, and invoice groups before confirmation.
- [ ] Warn on large or unbounded selections, force background execution above the configured threshold, and block only when a Xero field/line/payload limit requires a narrower selection.
- [ ] Ensure “all matching” covers the complete result set, not only the visible page.
- [ ] Save normalized filter semantics, timezone, sort, exclusions, and selection type for audit.
- [ ] Re-resolve IDs/filter and recheck eligibility at preview and confirmation.
- [ ] Reject stale or unauthorized IDs rather than silently dropping them.
- [ ] Group the prospective result by Xero contact and currency to show invoice count.

### Billing queue UI todo

- [ ] Build a custom billing queue for owner/admin/biller.
- [ ] Add work-date, customer, project, user, currency, and blocker filters.
- [ ] Show date, user, customer, project, complete description, duration, rate, amount, and mapping state.
- [ ] Add row, page, and all-filtered selection plus exclusion/clear actions.
- [ ] Keep selected count, minutes, value, and invoice count visible while paging.
- [ ] Add an “All uninvoiced” shortcut that includes every eligible unbilled entry and always proceeds through preview.
- [ ] Separate eligible and blocked entries rather than silently omitting blocked rows.
- [ ] Give every blocked row an actionable explanation.
- [ ] Warn when selected data changes between queue and preview.
- [ ] Handle empty, large, stale, concurrent, loading, and partial-error states.

### Verification and acceptance

- [ ] Every eligibility/blocker rule has unit tests.
- [ ] Explicit, page, all-filtered, and exclusion selection semantics have integration tests.
- [ ] “All uninvoiced” excludes non-billable, reserved, exported, and blocked entries.
- [ ] Totals remain exact across mixed minutes and rates.
- [ ] Selections remain correct across pagination.
- [ ] Role tests prove members have no billing access.
- [ ] End-to-end tests cover selected and all-filtered flows.

## WP-09 — Invoice preview, immutable snapshots, and reservation

Depends on: WP-05, WP-08

Outcome: The user sees the exact Xero drafts before confirmation; confirmation atomically reserves time and saves one immutable line mapping per entry.

### Preview construction todo

- [ ] Group entries into one prospective invoice per Xero ContactID and currency.
- [ ] Generate exactly one Xero line per time entry; do not aggregate entries by project, rate, date, or user.
- [ ] Include the full time-entry description in every line description.
- [ ] Define a configurable default line template that also identifies work date and project while preserving the user's description.
- [ ] Resolve line quantity from durationSeconds through one exact-decimal policy.
- [ ] Resolve unit amount from the time-entry rate snapshot.
- [ ] Resolve account, tax, and tracking using project overrides followed by Billing Settings.
- [ ] Set invoice type to ACCREC and status to DRAFT.
- [ ] Set invoice/due dates, reference, currency, and line amount type.
- [ ] Add a unique application reference that supports reconciliation.
- [ ] Validate contact state, organisation capability, account, tax, currency, tracking, field lengths, and payload size before confirmation.
- [ ] Make any truncation or formatting visible; do not silently alter descriptions.
- [ ] Show invoice header, every source entry/line, quantity, rate, subtotal, tax, and total.
- [ ] Link preview lines to source entries where authorized.
- [ ] Produce a preview checksum covering entry versions and all resolved billing settings.
- [ ] Run a Xero Demo Company precision spike for one-minute and representative hour/minute quantities.
- [ ] Document unavoidable Xero boundary rounding and ensure the UI preview matches it.

### Confirmation and reservation todo

- [ ] Reject a stale preview if any entry, rate snapshot, contact mapping, or billing setting changed.
- [ ] Begin one MongoDB transaction.
- [ ] Re-query selected entries and verify access/eligibility.
- [ ] Conditionally move entries from unbilled to reserved.
- [ ] Fail an entire customer/currency group if any entry cannot be reserved.
- [ ] Create the Export Batch.
- [ ] Create one Invoice Export per customer/currency.
- [ ] Create one Invoice Export Entry per time entry with:
  - [ ] source entry ID;
  - [ ] stable line ordinal;
  - [ ] work date/timezone;
  - [ ] user/project/customer snapshots;
  - [ ] full description;
  - [ ] duration/quantity;
  - [ ] rate/currency;
  - [ ] account/tax/tracking;
  - [ ] exact calculated amounts.
- [ ] Save sanitized Xero request payloads, hashes, application references, and the initial immutable Xero Attempt/idempotency key.
- [ ] Set currentExport on each reserved entry.
- [ ] Save each new Invoice Export in preparing state with a durable queue-pending marker.
- [ ] Commit the reservation, immutable snapshots, and dispatch intent before creating jobs or making any Xero request.
- [ ] After commit, queue one Payload job per Invoice Export, attach its job ID, and atomically move the export to queued.
- [ ] Add an idempotent dispatcher/sweeper that finds preparing exports without a job and attaches one.
- [ ] Keep entries reserved and surface a retryable dispatch error if job attachment fails; never silently discard or release the export intent.
- [ ] Roll back all local changes if snapshot/reservation creation fails.
- [ ] Permit preview cancellation without modifying any billing state.

### Concurrency and immutability todo

- [ ] Enforce one active export allocation per time entry using conditional writes plus indexes.
- [ ] Ensure two simultaneous confirmations cannot reserve the same entry.
- [ ] Make saved line/export snapshots immutable through generic CRUD.
- [ ] Keep time reserved after a caller timeout until the export outcome is known.
- [ ] Make duplicate job attachments harmless even if the dispatcher and request path race.
- [ ] Add a controlled repair diagnostic for impossible partial local states.

### Verification and acceptance

- [ ] Every selected entry produces exactly one preview and saved invoice line.
- [ ] Every line contains the source description and durable entry mapping.
- [ ] Grouping is only by contact/currency.
- [ ] Quantity, rate, tax, and total calculations match Xero Demo Company behavior.
- [ ] Stale previews are rejected with a useful refresh action.
- [ ] Real Mongo replica-set concurrency tests prove an entry cannot be reserved twice.
- [ ] Source edits after confirmation cannot change export snapshots.
- [ ] A process crash immediately after reservation commit is recovered by the dispatcher without losing the export or creating two invoices.

## WP-10 — Xero export execution and Payload jobs

Depends on: WP-05, WP-09

Outcome: Both Admin-selectable modes execute the same durable, idempotent export job, normally completing background work within one minute.

### Execution-mode todo

- [ ] Store xeroExportMode in Billing Settings as background or wait-for-result.
- [ ] Default to background.
- [ ] Save requestedMode and actualExecution on each batch/export.
- [ ] Always create a persisted Payload job, regardless of mode.
- [ ] For background mode, return after reservation and dispatch intent are committed; show preparing or queued according to whether job attachment has completed.
- [ ] For wait-for-result mode, invoke the created job by ID and wait for its result.
- [ ] If wait mode exceeds a short UI/request threshold, show “Continuing in background”; do not cancel the job.
- [ ] Force large/multi-invoice exports into background mode according to the documented threshold.
- [ ] Make mode changes affect only future batches.
- [ ] Keep allowBillerModeOverride false in V1 unless explicitly enabled by owner/admin.
- [ ] If enabled later, record the per-export override actor and reason.

### Payload job/workflow todo

- [ ] Define a typed CreateXeroInvoice task or workflow.
- [ ] Pass only Invoice Export ID as job input; load the immutable payload server-side.
- [ ] Send exactly one Invoice Export per Xero mutation request so one invalid invoice cannot create a partially successful multi-invoice response.
- [ ] Enable concurrency control and serialize Xero work for the one tenant conservatively.
- [ ] Configure bounded attempts and backoff.
- [ ] Make the handler application-idempotent independently of Payload job state.
- [ ] Atomically claim an export with a bounded processing lease; a runner that does not own the lease cannot send it.
- [ ] Before calling Xero:
  - [ ] load the export;
  - [ ] no-op if already succeeded/released;
  - [ ] reject changed payload hashes;
  - [ ] ensure entries remain reserved to this export;
  - [ ] acquire connection/token refresh lock;
  - [ ] refresh Xero accounting OAuth tokens if needed.
- [ ] Move state from queued to processing atomically.
- [ ] Create or load the immutable Xero Attempt before sending and conservatively persist requestMayHaveBeenSent as true immediately before initiating the network call.
- [ ] Validate every Xero idempotency key against the current documented length/format limit before persisting it.
- [ ] POST the saved invoice payload with Xero tenant header and Idempotency-Key.
- [ ] Use the current granular scopes and Xero SDK/API version.
- [ ] Capture attempt timing, HTTP classification, Xero correlation ID, and rate-limit headers without storing secrets.
- [ ] On success:
  - [ ] verify response invoice/contact/currency/line count;
  - [ ] save InvoiceID, InvoiceNumber, URL when available, remote status, and safe response metadata;
  - [ ] map returned LineItemIDs by saved ordinal;
  - [ ] atomically mark all reserved entries exported;
  - [ ] mark export succeeded;
  - [ ] write audit events.
- [ ] On a definite Xero validation failure:
  - [ ] mark action-required with structured remediation;
  - [ ] release reservations only when the request definitely did not create an invoice;
  - [ ] preserve the failed snapshot/history.
- [ ] On 429:
  - [ ] honor Retry-After;
  - [ ] pause or defer further tenant work until the safe retry time;
  - [ ] set retry-wait;
  - [ ] retry without changing payload/idempotency identity.
- [ ] On 401, perform at most one concurrency-safe token refresh/retry before requiring reconnection.
- [ ] On temporary 5xx/network failure proven to be before send, use bounded exponential backoff with jitter.
- [ ] On timeout/connection loss after possible send, set reconciling and keep entries reserved.
- [ ] If Xero confirms creation but the response materially differs from the snapshot, record the remote ID, keep entries locked, and enter manual-review rather than posting again.
- [ ] Never blindly issue a new POST after Xero's idempotency-cache window.
- [ ] Treat job completion status as orchestration only; use Invoice Export state for billing truth.

### Vercel job runner todo

- [ ] Configure a dedicated xero queue.
- [ ] Do not use Payload autoRun on Vercel.
- [ ] Add a secured Payload job-run endpoint restricted by CRON_SECRET.
- [ ] Configure Vercel Pro Cron to invoke the queue at one-minute intervals.
- [ ] Configure intentional function max-duration and shorter outbound Xero request timeouts; do not rely on Vercel terminating work cleanly.
- [ ] Limit jobs processed per invocation to stay within function and Xero limits.
- [ ] Protect against overlapping/duplicate cron invocations.
- [ ] Run the prepared-export dispatcher before or alongside ordinary queue work.
- [ ] Add manual owner/admin “Run queue now” for diagnostics without bypassing job locks.
- [ ] Add stale-processing detection and a safe recovery job.

### Export status UI todo

- [ ] Show preparing, queued, processing, retry-wait, action-required, reconciling, succeeded, cancelled, released, and manual-review states.
- [ ] Poll persisted status with backoff while a user watches an export.
- [ ] Stop polling on terminal states.
- [ ] Show Xero invoice number/link on success.
- [ ] Show actionable reconnect/mapping/configuration guidance without raw Xero payloads.
- [ ] Permit cancellation only while the export is preparing/queued and no attempt may have been sent.
- [ ] Cancel and release that export's reservations atomically while retaining its immutable snapshots and audit history.
- [ ] Permit safe retry only when the state machine allows it.

### Verification and acceptance

- [ ] Background mode returns promptly and is normally picked up within one minute.
- [ ] Wait mode runs the same job and safely continues in background after interruption.
- [ ] Double-click, duplicate cron, job retry, and concurrent runner tests create at most one Xero invoice.
- [ ] Success marks every mapped entry exported atomically.
- [ ] Definite failures never mark time exported.
- [ ] Ambiguous failures remain reserved and enter reconciliation.
- [ ] 429 and Retry-After behavior is tested.

## WP-11 — Reconciliation, Xero webhooks, and remote status

Depends on: WP-10

Outcome: Uncertain exports are resolved without duplicate invoices, and Xero-side invoice changes are reflected locally without automatically releasing time.

### Reconciliation todo

- [ ] Define a typed ReconcileXeroInvoice Payload task.
- [ ] Queue reconciliation immediately for ambiguous send/response outcomes.
- [ ] Keep the export payload, application reference, original idempotency key, and entries unchanged while reconciling.
- [ ] During Xero's idempotency-cache window, permit a retry only with the same method, URL, body, and key.
- [ ] Query Xero using the stored InvoiceID when one is known.
- [ ] Otherwise query using the unique application reference plus expected contact/date/currency constraints.
- [ ] Handle reconciliation results:
  - [ ] exactly one matching invoice with matching material values: finalize success;
  - [ ] exactly one invoice with material mismatch: manual-review;
  - [ ] several plausible invoices: manual-review;
  - [ ] confirmed no match while safe retry remains possible: retry-wait;
  - [ ] Xero unavailable or inconclusive: remain reconciling with bounded backoff.
- [ ] After Xero's idempotency cache expires, never repeat the POST until a targeted read has established that no invoice exists.
- [ ] If a new POST is justified after confirmed absence, create a new attempt/key linked to the original export rather than overwriting history.
- [ ] Verify contact, currency, reference, line count, line descriptions, quantities, and totals before treating a found invoice as the export result.
- [ ] Finalize reconciled success using the same atomic local completion service as a normal successful response.
- [ ] Expose a safe owner/admin manual reconciliation action that runs the same service.
- [ ] Require a reason for any manual-review resolution.
- [ ] Provide explicit owner/admin resolution commands for:
  - [ ] accepting and linking one verified existing Xero invoice;
  - [ ] confirming absence and authorizing a linked replacement attempt; and
  - [ ] leaving the case locked while escalating it.
- [ ] Never expose a generic “mark succeeded,” “mark failed,” or direct state editor.
- [ ] Add alerts for exports remaining processing/reconciling beyond operational thresholds.

### Webhook todo

- [ ] Register Xero invoice webhooks for staging and production.
- [ ] Receive the raw request body without mutation.
- [ ] Validate x-xero-signature with the configured webhook key and constant-time comparison.
- [ ] Validate expected content type and payload shape.
- [ ] Return 401 for invalid signatures.
- [ ] Return a cookie-free successful response within five seconds and queue actual processing.
- [ ] Implement Xero's webhook intent-to-receive validation and meet its response-time requirement with automated tests.
- [ ] Persist a minimal Xero Webhook Receipt before returning and deduplicate repeated events durably.
- [ ] Validate every event tenant ID against the configured single tenant.
- [ ] Ignore and alert on an event for another tenant.
- [ ] Fetch the authoritative invoice rather than trusting a minimal event as complete state.
- [ ] Cope with duplicated and out-of-order update events.
- [ ] Persist remote status, update timestamp, last sync, and safe change summary.
- [ ] Detect DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED, and DELETED transitions.
- [ ] Detect line count/identity/material changes to an exported invoice.
- [ ] Mark deleted, voided, or mismatched invoices action-required.
- [ ] Never change exported time back to unbilled from a webhook.
- [ ] Redact customer descriptions and financial payloads from routine webhook logs.

### On-demand and scheduled maintenance todo

- [ ] Add “Refresh from Xero” on invoice export detail.
- [ ] Add a periodic status reconciliation for active/recent exports without excessive polling.
- [ ] Add scheduled token keepalive/refresh before 60 days of inactivity.
- [ ] Add scheduled Xero connection and reference-data health checks.
- [ ] Add stale-job recovery that distinguishes a pre-send crash from a possibly-sent request.
- [ ] Add an operations view for stuck, retry-wait, reconciling, action-required, and manual-review exports.

### Verification and acceptance

- [ ] Webhook signature, wrong-tenant, duplicate, out-of-order, slow-processing, and retry tests pass.
- [ ] An ambiguous POST that created an invoice is reconciled without a second invoice.
- [ ] A confirmed absent invoice can be retried through a linked attempt.
- [ ] A mismatch or multiple matches cannot be auto-resolved.
- [ ] Xero-side deletion/voiding becomes visible but does not automatically release entries.
- [ ] On-demand and scheduled reconciliation stay inside Xero rate limits.

## WP-12 — Admin release and rebill

Depends on: WP-11

Outcome: Owner/admin can explicitly release the entries of a verified deleted or voided Xero invoice and send them through the ordinary billing flow again, with immutable lineage.

### Rules and state todo

- [ ] Restrict all release/rebill commands to owner/admin.
- [ ] Make V1 release operate on the complete Invoice Export, not arbitrary individual lines.
- [ ] Refresh the invoice from Xero immediately before offering or executing release.
- [ ] Permit release only when the remote invoice is verified DELETED or VOIDED.
- [ ] Block release when the invoice is DRAFT, SUBMITTED, AUTHORISED, PAID, missing but inconclusive, or unavailable.
- [ ] Do not let an administrator bypass remote verification with generic “mark unbilled” editing.
- [ ] Require a non-empty human reason and explicit confirmation.
- [ ] Keep original Export Batch, Invoice Export, Invoice Export Entries, payload, Xero IDs, totals, and state history immutable.
- [ ] Add release metadata or a separate append-only Release Action record:
  - [ ] source export;
  - [ ] affected entries/allocations;
  - [ ] last verified remote status;
  - [ ] actor;
  - [ ] reason;
  - [ ] timestamp;
  - [ ] before/after states;
  - [ ] later replacement exports.
- [ ] Perform release in one MongoDB transaction:
  - [ ] recheck current export/entry state;
  - [ ] ensure it has not already been released;
  - [ ] create release/audit records;
  - [ ] mark allocations released but retain them;
  - [ ] move every mapped entry from exported to unbilled;
  - [ ] clear only its active currentExport pointer;
  - [ ] mark the original Invoice Export released.
- [ ] Prevent concurrent double release using conditional writes/indexes.
- [ ] Ensure releasing does not itself create a replacement invoice.
- [ ] When rebilled later, record rebillOf lineage to the release and original export.
- [ ] Keep a released entry editable only according to ordinary unbilled rules.

### Admin UX todo

- [ ] Add a protected export-detail Admin view with remote state, mapped entries/lines, last reconciliation, and history.
- [ ] Add “Refresh status from Xero.”
- [ ] Show action-required guidance for deleted/voided/mismatched invoices.
- [ ] Show “Release for rebilling” only when eligibility is verified.
- [ ] Preview affected entry count, minutes, original amount, customer, and invoice number.
- [ ] Explain that all entries on the invoice will return to the unbilled queue.
- [ ] Require typed reason and high-impact confirmation.
- [ ] After release, provide “Open rebill preview” with released entry IDs preselected.
- [ ] Route the replacement through the normal eligibility, preview, reservation, and job flow.
- [ ] Display original invoice -> release -> replacement invoice lineage in both directions.

### Verification and acceptance

- [ ] Member/biller cannot release through UI, REST, or Local API.
- [ ] Active/authorised/paid/inconclusive invoices cannot be released.
- [ ] A verified deleted/voided export can be released exactly once.
- [ ] All mapped entries update atomically and reappear in the normal billing queue.
- [ ] Original snapshots remain unchanged.
- [ ] Replacement exports preserve complete rebillOf lineage.
- [ ] Concurrent release/rebill tests cannot duplicate state changes or invoices.

## WP-13 — Security, audit, observability, and operational controls

Depends on: Starts at WP-00 and closes after WP-12

Outcome: The application fails closed, protects credentials and billing data, provides actionable diagnostics, and maintains a trustworthy audit history.

### Security todo

- [ ] Create and maintain a threat model covering email authentication, invitations, Xero OIDC, account linking, local sessions, Payload Admin, Local API elevation, accounting OAuth, MongoDB, webhooks, jobs, billing commands, and log leakage.
- [ ] Cover login CSRF, state/nonce/code replay, callback mix-up, session fixation, invitation replay, provider-subject collision, email-based account takeover, open redirect, and identity/accounting credential mix-up explicitly.
- [ ] Maintain a role-by-resource-by-operation access matrix.
- [ ] Enforce access in collections, fields, custom endpoints, domain services, and Local API wrappers.
- [ ] Treat Admin hidden/read-only configuration as presentation only, never as authorization.
- [ ] Disable unused APIs such as GraphQL and unnecessary Payload endpoints.
- [ ] Set strict CORS and CSRF origins.
- [ ] Set secure, HTTP-only, same-site cookies and suitable session lifetimes.
- [ ] Namespace identity/accounting routes, flow records, cookies, callback validation, log fields, and metrics so a request cannot cross trust boundaries.
- [ ] Fail startup if the identity and accounting client IDs, secrets, redirect URIs, or route handlers are reused or ambiguously configured.
- [ ] Apply authentication and command rate limits.
- [ ] Validate all custom route inputs with shared schemas and reject unknown fields.
- [ ] Add request/body size limits.
- [ ] Add security headers and a Content Security Policy compatible with Payload Admin.
- [ ] Sanitize output rendered in descriptions and Admin diagnostics.
- [ ] Prevent mass assignment of roles, rates, billing states, Xero IDs, token fields, audit actors, and export state.
- [ ] Encrypt Xero accounting tokens with versioned authenticated encryption and rotation support; identity tokens are never retained.
- [ ] Keep PAYLOAD_SECRET, accounting token-encryption keys, auth-flow encryption keys, identity/accounting OAuth secrets, webhook key, and CRON_SECRET separate.
- [ ] Add independent audited kill switches for Xero identity sign-in and accounting export/processing.
- [ ] Document and test secret rotation.
- [ ] Protect cron/job endpoints with machine-only authentication and constant-time checks.
- [ ] Configure Atlas with a least-privilege database user, TLS, alerts, and an explicit network-access decision.
- [ ] Review all logs and error reports for ID/access/refresh tokens, authorization codes, state, nonce, PKCE verifier, invitation tokens, provider subjects, session cookies/hashes, descriptions, emails, and full invoice payloads.
- [ ] Run dependency, secret, and static-analysis scans in CI.

### Audit todo

- [ ] Define a stable audit-event taxonomy.
- [ ] Record authentication administration, invitation acceptance method, Xero identity success/failure, link/unlink/collision/recovery, session revocation, role changes, accounting connect/disconnect/reconnect/handover, mapping changes, privileged time corrections, export transitions, retries, reconciliation, release/rebill, and diagnostic overrides.
- [ ] Include actor, target, timestamp, correlation ID, reason, and redacted before/after values.
- [ ] Record machine actors separately from human actors.
- [ ] Make Audit Events append-only to application users, including owners.
- [ ] Prevent audit hooks from recursively generating duplicate audit records.
- [ ] Establish retention and archive policy.
- [ ] Add Admin search/filter by date, actor, event type, customer, entry, export, and Xero invoice.
- [ ] Test that failed transactions do not leave false audit events and successful transitions do.

### Observability todo

- [ ] Add structured server logging with request, batch, export, job, tenant, and Xero correlation IDs.
- [ ] Establish log levels and redact at the logger boundary.
- [ ] Configure error monitoring with environment/release tagging and source maps.
- [ ] Add metrics or queries for:
  - [ ] login/auth failures;
  - [ ] password versus Xero identity login success/failure and latency;
  - [ ] OIDC callback replay/claim failures, invite mismatches, and identity-link collisions;
  - [ ] active/revoked external sessions and stale Auth Identities;
  - [ ] unbilled and blocked entries;
  - [ ] queued and processing job age;
  - [ ] Xero success/failure/429 counts;
  - [ ] token refresh health;
  - [ ] reconciliation age;
  - [ ] manual-review count;
  - [ ] webhook validity/failures;
  - [ ] Mongo connection/transaction failures.
- [ ] Add alerts for identity-provider failures, abnormal callback/link failures, accounting connection loss, repeated accounting-token failures, authorizer departure risk, webhook disablement risk, stuck exports, rate-limit exhaustion, and backup failure.
- [ ] Add a health endpoint that checks application readiness without leaking environment details.
- [ ] Add Admin operational diagnostics with safe retry/refresh links.

### Operational todo

- [ ] Document backup, restore, identity-provider outage, compromised identity link, password/owner recovery, identity client-secret rotation, accounting client/token compromise, accounting-authorizer departure/handover, Xero disconnect, token refresh failure, webhook failure, stuck export, duplicate-suspected invoice, and release/rebill runbooks.
- [ ] Add owner-controlled, audited kill switches for accepting new exports and wait-for-result execution without hiding or mutating existing export history.
- [ ] Prove Xero identity sign-in can be disabled without stopping email/password login or accounting jobs, and accounting export can be disabled without stopping either login method.
- [ ] If cron or webhook processing needs to be paused during an incident, retain durable pending work and document safe resumption.
- [ ] Exercise restore and at least one export incident scenario in staging.
- [ ] Define data retention, user offboarding, and customer archive behavior.
- [ ] On user offboarding, revoke every local session and identity link as policy requires while preserving minimal audit history; do not automatically disconnect the business accounting grant.
- [ ] Keep historical billing/audit records when a user/customer/project is deactivated.

### Verification and acceptance

- [ ] The full access matrix has automated coverage.
- [ ] Secret-scanning and deliberate canary-secret tests find no client/log exposure.
- [ ] Automated separation tests prove neither OAuth flow can read or mutate the other flow's records.
- [ ] Audit events accurately follow committed state.
- [ ] Alerts fire in controlled staging failure exercises.
- [ ] Restore and incident runbooks are executable by someone other than the implementer.

## WP-14 — Full-system verification and CI quality gates

Depends on: All feature packages

Outcome: Automated and manual evidence shows the system behaves correctly under ordinary, concurrent, and failure conditions.

### Test architecture todo

- [ ] Run unit tests without network dependencies.
- [ ] Run integration tests against a real MongoDB replica set, never SQLite or standalone Mongo.
- [ ] Create deterministic factories for users, invitations, Auth Identities, external sessions, OAuth flows, customers, projects, entries, exports, Xero responses, and jobs.
- [ ] Create a controllable fake OIDC provider distinct from the fake accounting API, including discovery, JWKS/key rotation, valid codes/tokens, malformed claims, errors, and provider outage.
- [ ] Create a controllable fake Xero server/client supporting success, validation errors, 401, 429, 5xx, connection reset, delayed response, ambiguous creation, and reconciliation queries.
- [ ] Store representative redacted Xero contract fixtures.
- [ ] Keep a separate manual/CI-safe Xero Demo Company contract suite.
- [ ] Reset or uniquely namespace test data for parallel runs.

### Mandatory unit coverage

- [ ] timezone parsing and DST resolution;
- [ ] range/duration conversion;
- [ ] project-rate scaled arithmetic;
- [ ] billing eligibility and blockers;
- [ ] filter normalization and all-matching semantics;
- [ ] grouping by contact/currency;
- [ ] one-entry-to-one-line invoice construction;
- [ ] Xero precision/rounding boundary;
- [ ] payload hashing/idempotency identity;
- [ ] export and entry state machines;
- [ ] retry classification;
- [ ] reconciliation decisions;
- [ ] release/rebill eligibility;
- [ ] access predicates and redaction;
- [ ] issuer/subject identity resolution and normalized invite-email comparison;
- [ ] identity-scope allow-list and accounting-scope rejection;
- [ ] OIDC state, nonce, issuer, audience, expiry, and return-path validation;
- [ ] identity link/unlink/recovery eligibility and session expiry/revocation;
- [ ] identity/accounting callback routing and data-boundary guards.

### Mandatory integration/concurrency coverage

- [ ] Payload collection and field access for every role and operation.
- [ ] Local API overrideAccess wrapper behavior.
- [ ] Mongo transaction rollback across collections.
- [ ] two billers reserving the same entry;
- [ ] two release attempts;
- [ ] duplicate submit/double-click;
- [ ] duplicate and overlapping cron invocations;
- [ ] concurrent OAuth token refresh;
- [ ] two callbacks consuming the same invite or linking the same provider subject;
- [ ] duplicate/replayed OIDC state, nonce, and authorization code;
- [ ] Xero email change after initial issuer/subject link;
- [ ] local session fixation, rotation, suspension, logout-all, and unlink;
- [ ] identity client misconfigured with accounting/offline scopes;
- [ ] identity/accounting client or callback reuse rejected at startup;
- [ ] identity callback attempts to mutate Xero Connection;
- [ ] accounting callback attempts to create a user/session;
- [ ] accounting authorizer handover, concurrent callbacks, wrong tenant/scopes, failed validation, and safe rollback;
- [ ] crash before Xero send;
- [ ] crash after reservation commit but before Payload job attachment;
- [ ] Xero creates invoice then response is lost;
- [ ] crash after Xero response but before local finalization;
- [ ] stale processing-job recovery;
- [ ] webhook duplicate/out-of-order delivery;
- [ ] immutable snapshots and audit records.

### Mandatory end-to-end coverage

- [ ] owner bootstrap and email/password recovery;
- [ ] invite acceptance by email/password and by the bound Xero identity flow;
- [ ] explicit Xero link, login, unlink, relink/recovery, reset, and deactivate;
- [ ] uninvited Xero user denial and no automatic merge on matching email;
- [ ] email/password login while Xero identity is disabled/unavailable;
- [ ] Xero login/logout/link/unlink with accounting connection values unchanged;
- [ ] accounting disconnect/reconnect with user sessions unchanged;
- [ ] member denial from Admin;
- [ ] member range and duration entry in selectable timezone;
- [ ] customer import/link/create in Xero;
- [ ] project/rate management;
- [ ] selected-entry billing preview/export;
- [ ] all-filtered uninvoiced preview/export;
- [ ] background completion;
- [ ] wait-for-result completion and fallback;
- [ ] action-required and reconnect;
- [ ] ambiguous result and reconciliation;
- [ ] Xero deleted/voided status refresh;
- [ ] Admin release and successful rebill;
- [ ] responsive and keyboard-critical flows.

### CI todo

- [ ] Run formatting, lint, TypeScript, Payload type/import-map freshness, unit tests, integration tests, and production build on every pull request.
- [ ] Run end-to-end tests on protected branches or suitable preview environments.
- [ ] Fail CI when generated Payload types/import map differ from committed output.
- [ ] Run dependency audit, license policy, static analysis, and secret scanning.
- [ ] Pin CI action/tool versions.
- [ ] Upload useful test, coverage, Playwright, and build artifacts without secrets.
- [ ] Set meaningful coverage thresholds for domain/access/state-machine code.
- [ ] Add a compatibility smoke test for the pinned Payload/Next.js bundle.
- [ ] Add a documented dependency upgrade/regression procedure.
- [ ] Add a controlled Xero Demo Company pre-release checklist rather than running destructive live tests on every PR.
- [ ] Perform a realistic performance test for time-entry list/filter, billing query, large preview, and bounded job batches.

### Verification and acceptance

- [ ] All mandatory test suites pass from a clean checkout.
- [ ] No flaky concurrency or timezone test is accepted as “retry until green.”
- [ ] A deliberate ambiguous Xero failure produces one invoice and a reconciled local result.
- [ ] A security/access regression causes CI to fail.
- [ ] A deliberate cross-flow read/write attempt causes CI to fail.
- [ ] The release candidate passes the Xero Demo Company checklist.

## WP-15 — Staging, production launch, and handover

Depends on: WP-13, WP-14

Outcome: A monitored, backed-up production deployment is connected to the intended Xero organisation and can be safely operated.

### Staging todo

- [ ] Deploy staging with its own Atlas database, secrets, stable hostname, email sandbox/configuration, and Xero Demo Company.
- [ ] Provision distinct staging Xero identity and accounting clients with different client IDs/secrets.
- [ ] Confirm the exact identity callback, accounting callback, and webhook URLs separately.
- [ ] Verify identity authorization requests contain only `openid profile email` and do not create a tenant connection.
- [ ] Exercise password login, invite-gated Xero acceptance, explicit link/login/unlink, provider outage fallback, and session revocation.
- [ ] Prove identity flows leave the Demo Company accounting connection unchanged and accounting flows leave user sessions unchanged.
- [ ] Configure one-minute secured Xero queue runner on Vercel Pro.
- [ ] Verify region placement and Mongo connection-pool behavior under concurrent functions.
- [ ] Run migrations/index creation in a controlled, repeatable step.
- [ ] Seed staging owner and baseline settings idempotently.
- [ ] Run full smoke, end-to-end, failure-injection, accessibility, and restore tests.
- [ ] Verify error monitoring, logs, metrics, and alerts.
- [ ] Obtain product sign-off on invitation, both login methods, identity linking/recovery, time-entry, billing preview, Admin, and release/rebill flows.

### Production readiness todo

- [ ] Provision production Atlas Flex or better with backups and alerts.
- [ ] Create a least-privilege production database user and final network allow-list.
- [ ] Configure production Vercel environment, domain, region, Pro Cron, and deployment protection as appropriate.
- [ ] Generate production-only PAYLOAD_SECRET, token-encryption key, CRON_SECRET, and application secrets.
- [ ] Provision separate production Xero identity and accounting client registrations and secrets.
- [ ] Register and verify the production identity callback, accounting callback, and webhook URLs independently.
- [ ] Confirm startup rejects reused client IDs, secrets, or callback routes.
- [ ] Configure the production email sender/domain.
- [ ] Verify production email SPF, DKIM, DMARC, invitation delivery, and password-reset delivery.
- [ ] Configure production error monitoring and alert recipients.
- [ ] Start production with the new-export kill switch enabled while configuration and read-only health checks are verified.
- [ ] Verify environment variables against a checklist without printing their values.
- [ ] Run index/migration status checks.
- [ ] Seed exactly one initial owner securely and verify its email/password recovery before enabling Xero sign-in.
- [ ] Configure Business Settings, Authentication Settings, user timezone defaults, base currency, and Billing Settings.
- [ ] Connect the intended Xero organisation through the dedicated standard accounting OAuth client.
- [ ] Verify tenant name/ID before saving the connection.
- [ ] Sync accounts, taxes, currencies, organisation actions, and contacts.
- [ ] Select and validate the default revenue account, tax type, due terms, and line amount mode.
- [ ] Import/link initial customers and create projects/rates.
- [ ] Verify Xero draft creation with a controlled low-value test and delete/release it through the intended procedure.
- [ ] Enable exports only for the controlled first batch, compare its Xero draft line by line, then explicitly open normal export access.
- [ ] Confirm webhook delivery and remote-status refresh.
- [ ] Confirm queued work normally begins within one minute.
- [ ] Confirm backup success before accepting real billing data.
- [ ] Launch Xero identity sign-in behind its independent feature flag, initially for owner/admin verification, then enable it for invited frontend users.

### Launch and handover todo

- [ ] Freeze a release candidate and record exact dependency versions.
- [ ] Run final CI and production smoke checklist.
- [ ] Invite initial users and verify member/admin boundaries.
- [ ] Verify initial users can choose email/password or invite-gated Xero sign-in without changing their locally assigned role.
- [ ] Provide short user guides for:
  - [ ] manual range entry;
  - [ ] manual hours/minutes entry;
  - [ ] timezone preference;
  - [ ] accepting an invitation and signing in with Xero;
  - [ ] linking/unlinking Xero and password recovery;
  - [ ] customer/project management;
  - [ ] billing selection and preview;
  - [ ] background/wait export;
  - [ ] mapping/action-required remediation;
  - [ ] release and rebill.
- [ ] Provide operator runbooks from WP-13.
- [ ] Document deployment, rollback, secret rotation, index migration, backup restore, and dependency upgrade.
- [ ] Define the rollback point and ensure rollback does not run incompatible data migrations.
- [ ] Monitor password login, Xero identity OIDC, accounting OAuth/token refresh, Mongo, jobs, webhooks, and exports as separate signals during the launch window.
- [ ] Review early audit records and Xero invoice mappings manually.
- [ ] Record V1 known limitations and post-launch backlog.

### Verification and acceptance

- [ ] Production is connected to the correct Xero tenant and cannot silently switch tenants.
- [ ] A controlled production draft invoice has a one-to-one line/time-entry mapping.
- [ ] Member users cannot access Admin or financial data.
- [ ] An uninvited Xero user cannot register, and Xero identity claims cannot change a local role.
- [ ] Identity sign-in and accounting OAuth remain operationally and cryptographically separated in production.
- [ ] Email/password login works while Xero identity sign-in is disabled.
- [ ] Queue, token refresh, webhook, monitoring, and backups are healthy.
- [ ] Another operator can follow the documented recovery and release/rebill procedures.

## 10. Implementation defaults fixed by this plan

These defaults remove remaining ambiguity for implementation. Change one through an architecture decision before its dependent work package begins.

- Business timezone default: Pacific/Auckland; every user and entry can select another valid IANA timezone.
- Duration precision: whole minutes; no application billing-rounding increment.
- Xero boundary precision: proven in WP-09 and displayed exactly in preview.
- Maximum duration: 24 hours per entry unless changed before WP-07.
- Overnight range entry: supported only with an explicit next-day/end-date choice.
- Overlapping entries: warning, not a hard block.
- Rate source: project rate snapshotted when a time entry is created.
- Retrospective rate change: explicit owner/admin recalculation of selected unbilled entries only.
- Customer creation: local first or imported from Xero; never silently created in Xero during export.
- Invoice status: DRAFT.
- Invoice grouping: one per Xero contact and currency.
- Invoice lines: exactly one per time entry, containing its description.
- Editing after export: locked.
- Release scope: all entries on one verified deleted/voided Invoice Export in V1.
- Export execution default: background.
- Per-export biller override: disabled by default.
- Queue pickup: Vercel Pro one-minute Cron with safe overlap handling.
- Production MongoDB: Atlas Flex or better; local/test Mongo must be a replica set.
- Registration: public self-registration is disabled; every user is created through an invitation or owner bootstrap.
- Login methods: email/password remains supported; invited users may optionally accept/link and sign in with Xero.
- External identity key: Xero issuer/subject is canonical; email is never used for automatic linking or merging.
- Identity scopes: exactly `openid profile email`; no `offline_access` or accounting scope is requested by the identity client.
- OAuth separation: Xero identity and accounting use distinct app/client registrations, callbacks, state, secrets, storage, and monitoring.
- Accounting renewal: routine application login never supplies or replaces accounting tokens; it may enqueue only a non-blocking health check using the existing server-held grant.
- Accounting authority: connect, reconnect, disconnect, and authorizer handover are explicit owner/admin operations pinned to the configured tenant.
- Recovery: at least one active owner retains a tested email/password recovery method.
- Xero identity rollout: disabled by default in a new environment, then enabled for invited users after the staged separation checks pass.

## 11. Suggested implementation order

1. Complete WP-00 through WP-04 as the vertical foundation.
2. Complete WP-05 and verify a Demo Company Xero connection before building contact-dependent UI.
3. Complete WP-06 and WP-07 to deliver usable manual time entry.
4. Complete WP-08 and WP-09 to validate billing without remote mutations.
5. Complete WP-10 and WP-11 against the Xero Demo Company.
6. Complete WP-12 and exercise the full delete/release/rebill path.
7. Close the cross-cutting WP-13 controls.
8. Pass WP-14 and launch through WP-15.

Feature packages should not be declared complete while their tests are deferred to WP-14. WP-14 is a final system gate, not a substitute for package-level testing.

## 12. Authoritative implementation references

Recheck these references when each dependent package starts because hosted-service and API constraints can change.

- [Payload overview](https://payloadcms.com/docs/getting-started/what-is-payload)
- [Payload MongoDB adapter](https://payloadcms.com/docs/database/mongodb)
- [Payload access control](https://payloadcms.com/docs/access-control/overview)
- [Payload authentication overview](https://payloadcms.com/docs/authentication/overview)
- [Payload custom authentication strategies](https://payloadcms.com/docs/authentication/custom-strategies)
- [Payload cookie authentication](https://payloadcms.com/docs/authentication/cookies)
- [Payload Local API and access behavior](https://payloadcms.com/docs/local-api/overview)
- [Payload transactions](https://payloadcms.com/docs/database/transactions)
- [Payload Jobs Queue](https://payloadcms.com/docs/jobs-queue/overview)
- [Payload deployment guidance](https://payloadcms.com/docs/production/deployment)
- [Xero OAuth authorization-code flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow)
- [Xero OAuth scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/)
- [Xero token lifecycle](https://developer.xero.com/documentation/guides/oauth2/token-types)
- [Sign in with Xero](https://developer.xero.com/documentation/xero-app-store/app-partner-guides/sign-in/)
- [Xero token, tenant, and connection identity guidance](https://developer.xero.com/documentation/best-practices/data-integrity/managing-tokens)
- [Xero connection lifecycle](https://developer.xero.com/documentation/best-practices/managing-connections/connections)
- [Xero idempotent requests](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/)
- [Xero API limits](https://developer.xero.com/documentation/guides/oauth2/limits)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
- [Vercel Cron security](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
