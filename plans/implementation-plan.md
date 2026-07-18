# Xero Time Tracker — Implementation Plan

Status: Local implementation complete; external provisioning, live-provider validation, deployment, and operator sign-off remain
Plan date: 18 July 2026
Target: Single-business application deployed to Vercel Pro
Application stack: Next.js, Payload CMS, MongoDB Atlas, Resend, TypeScript

## 1. Purpose

Build a secure internal time-tracking application for customer projects. Invited users authenticate by email/password or optional Xero sign-in and record completed time manually. Privileged users manage customers, projects, rates, billing settings, and the business Xero accounting connection. Billable time can be selected explicitly, or selected as all eligible unbilled entries matching an optional filter, previewed, and exported to new Xero draft invoices.

The plan is deliberately split into dependency-ordered work packages. Every package contains implementation tasks, verification work, and an acceptance gate. A package is complete only when its implementation, tests, documentation, and operational requirements are complete.

Implementation checkpoint (19 July 2026): all locally actionable V1 slices are implemented. This includes invite-only email/password and Xero identity authentication, guarded owner transition and identity recovery, strict role/Admin boundaries, manual timezone-aware time entry, overlap handling, customers/projects/rates and explicit Xero contact mapping, owner/admin-configurable Xero accounting OAuth with an encrypted client secret, encrypted rotating grants and safe authorizer handover, reference-data validation, billing eligibility and live selection summaries, exact one-entry/one-line previews, transactional reservation, durable background/wait-mode jobs, idempotent export/retry/reconciliation, signed durable webhooks, authoritative remote refresh, and verified release/rebill lineage. Security headers, rate limits, bounded request inputs, redacted structured logging, health/operations views, 62 verified MongoDB indexes, migrations, CI, deployment/runbook/user documentation, deterministic fakes/fixtures, performance gates, and dependency/secret/license scans are present. The current automated gate covers 141 unit/integration tests, 3 performance tests, and 21 Chromium end-to-end cases; production build, generated artifacts, compatibility, formatting, lint, TypeScript, index verification, and a zero-known-vulnerability production dependency audit pass locally. Unchecked items below now require user-owned or external state: Git remote selection, Atlas/Vercel/Resend/error-monitoring provisioning, Xero app registrations and Demo Company/live contract checks, hosted callbacks/webhooks, backup/alert drills, deployment, named backup operator, and product/production sign-off.

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

| ID    | Work package                                                           | Primary dependencies                |
| ----- | ---------------------------------------------------------------------- | ----------------------------------- |
| WP-00 | Repository and engineering foundation                                  | None                                |
| WP-01 | Environments, MongoDB Atlas, Vercel, and external services             | WP-00                               |
| WP-02 | Payload core and database model                                        | WP-00, WP-01                        |
| WP-03 | Authentication, Xero sign-in, invitations, roles, and route protection | WP-02                               |
| WP-04 | Admin foundation and application settings                              | WP-02, WP-03                        |
| WP-05 | Xero accounting OAuth connection and reference data                    | WP-01, WP-02, WP-03, WP-04          |
| WP-06 | Customers, Xero contact mapping, projects, and rates                   | WP-04, WP-05                        |
| WP-07 | Manual time-entry domain and member UI                                 | WP-03, WP-06                        |
| WP-08 | Billing eligibility, filters, and selection                            | WP-04, WP-06, WP-07                 |
| WP-09 | Invoice preview, snapshots, and reservation                            | WP-05, WP-08                        |
| WP-10 | Xero export execution and Payload jobs                                 | WP-05, WP-09                        |
| WP-11 | Reconciliation, webhooks, and remote status                            | WP-10                               |
| WP-12 | Admin release and rebill                                               | WP-11                               |
| WP-13 | Security, audit, observability, and operations                         | Begins at WP-00; closes after WP-12 |
| WP-14 | Full-system verification and CI quality gates                          | All feature packages                |
| WP-15 | Staging, production launch, and handover                               | WP-13, WP-14                        |

## WP-00 — Repository and engineering foundation

Depends on: none

Outcome: A reproducible, secret-safe Payload/Next.js repository with pinned tooling and fast quality checks.

Implementation note (2026-07-18): the deployable Payload/Next.js project lives in `app/`; Vercel must use `app` as its Root Directory. The project currently uses Payload 3.86.0, Next.js 16.2.6, and pnpm 10.28.1.

### Todo

- [ ] Choose and publish the Git upstream before enabling remote CI. Read-only verification on 18 July 2026 confirmed `git@github.com:Lightnicus/xero-time.git` is reachable but has no branch heads; pushing/retargeting it requires repository-owner authorization and a deliberate commit boundary.
- [x] Scaffold from the current supported Payload blank application template.
- [x] Use pnpm and generate the lockfile for inclusion with the setup changes.
- [x] Pin an exact compatible set of Next.js, Payload, and all Payload packages.
- [x] Declare the supported Node.js range in package metadata and document Node.js 24 LTS as the hosted target.
- [x] Enable strict TypeScript and useful no-unchecked-access options.
- [x] Organize routes into isolated Payload and custom-application route groups.
- [x] Create source boundaries for:
  - [x] Payload collections and globals;
  - [x] access-control helpers;
  - [x] identity/OIDC and local session services;
  - [x] domain services;
  - [x] Xero identity/OIDC client with no retained provider tokens;
  - [x] Xero accounting client and rotating token service;
  - [x] jobs and workflows;
  - [x] custom route handlers;
  - [x] UI components;
  - [x] test factories and fixtures.
- [x] Expand .gitignore for dependencies, Next.js output, Payload output, Vercel state, environment files, coverage, Playwright artifacts, logs, local Mongo data, and editor/OS files.
- [x] Add .env.example containing names and descriptions only.
- [x] Configure linting, formatting, type checking, and import ordering.
- [x] Add scripts for dev, build, start, lint, typecheck, unit tests, integration tests, end-to-end tests, Payload type generation, import-map generation, migrations, and seed data.
- [x] Add a root README with local prerequisites, setup, commands, and links to this plan.
- [x] Add a small architecture-decision record directory and record:
  - [x] Payload as the application framework;
  - [x] MongoDB instead of Postgres;
  - [x] single-business boundary;
  - [x] invite-gated optional Xero sign-in alongside email/password;
  - [x] separate Xero identity and accounting OAuth clients;
  - [x] standard Xero accounting OAuth;
  - [x] persisted export saga;
  - [x] custom member UI versus generated Admin.
- [x] Configure a test runner and DOM test environment.
- [x] Configure Playwright with isolated test data.
- [x] Add a pre-commit or pre-push fast check without making local development dependent on an external service.
- [x] Add a dependency-update policy requiring Payload packages to update together.
- [x] Ensure no secret, local database, or IDE file becomes tracked.

### Verification and acceptance

- [x] A clean checkout installs reproducibly with one documented command.
- [x] Development server, lint, typecheck, unit tests, and production build succeed.
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
- [x] Document the Vercel dynamic-egress trade-off and choose either:
  - [ ] restricted static egress where available; or
  - [x] broad network allow-list with strong least-privilege credentials and monitoring.
- [x] Set a conservative Mongoose pool configuration suitable for serverless instances.
- [ ] Configure Atlas alerts for connections, storage, replication, and availability.
- [ ] Configure and test backup retention and a restore procedure.
- [ ] Create Vercel staging and production projects or environments on the Pro plan.
- [x] Select and document the Vercel function region.
- [ ] Configure a stable staging hostname and production hostname.
- [ ] Create distinct Xero identity and accounting app/client registrations for each hosted environment; never reuse one client ID across the two trust boundaries.
- [ ] Connect the development application to a Xero Demo Company.
- [ ] Register separate exact identity and accounting OAuth callback URLs; do not use wildcard or shared callbacks.
- [ ] Reserve the Xero webhook URLs for staging and production.
- [x] Select Resend and integrate Payload's official adapter for invitations and password reset.
- [ ] Verify the Resend sender domain and provision/test environment-specific API keys and senders.
- [x] Define environment variables:
  - [x] DATABASE_URL;
  - [x] PAYLOAD_SECRET;
  - [x] AUTH_FLOW_ENCRYPTION_KEY and key version;
  - [x] NEXT_PUBLIC_SERVER_URL or equivalent public origin;
  - [x] XERO_IDENTITY_CLIENT_ID;
  - [x] XERO_IDENTITY_CLIENT_SECRET;
  - [x] XERO_IDENTITY_REDIRECT_URI;
  - [x] XERO_WEBHOOK_KEY;
  - [x] CRON_SECRET;
  - [x] ACCOUNT_EMAIL_DELIVERY_MODE, RESEND_API_KEY, RESEND_FROM_ADDRESS, and RESEND_FROM_NAME;
  - [x] error-monitoring credentials;
  - [x] optional seed-owner variables for initial provisioning.
- [ ] Set different secret values in every environment.
- [x] Store the accounting OAuth client ID and encrypted client secret in the hidden singleton Payload record through a protected owner/admin workflow.
- [x] Derive the accounting callback from the public application origin and purpose-separated configuration/token keys from `PAYLOAD_SECRET`, so accounting setup needs no environment change or restart.
- [x] Reject configured identity credential reuse when accounting credentials are saved or loaded; keep fixed, distinct callback routes.
- [x] Document secret generation, rotation, revocation, and emergency replacement.
- [x] Ensure preview deployments cannot reach or migrate production data by default.

### Verification and acceptance

- [x] Local integration tests successfully commit and roll back a multi-document transaction.
- [x] CI runs the same replica-set transaction coverage.
- [ ] Staging connects to its own Atlas data and Xero Demo Company.
- [ ] Staging identity and accounting callbacks use different Xero client IDs/routes and cannot consume each other's OAuth state.
- [ ] Production configuration is isolated and contains no demo credentials.
- [ ] A documented backup restore is tested against a non-production database.
- [ ] Vercel can build without exposing secret values to client bundles or logs.

## WP-02 — Payload core and database model

Depends on: WP-00, WP-01

Outcome: Payload collections, globals, generated types, MongoDB indexes, and transaction helpers reflect the agreed domain.

### Todo

- [x] Configure Payload with mongooseAdapter and the environment-specific MongoDB URL.
- [x] Configure safe Mongoose connection and transaction options.
- [x] Configure the Payload secret and canonical server URL.
- [x] Disable GraphQL if it is not used by the custom application.
- [x] Set conservative REST depth and pagination defaults.
- [x] Implement the Users collection.
- [x] Implement the private Invitations collection for email/password setup links.
- [x] Implement the private Auth Identities and External Auth Sessions collections plus their identity-flow state model.
- [x] Implement the private accounting OAuth Flow States collection with hidden state/binding hashes and encrypted pending grants.
- [x] Implement Business Settings, Authentication Settings, and Billing Settings globals.
- [x] Implement Customers, Projects, and Time Entries collections.
- [x] Implement the private singleton Xero Connection collection.
- [x] Implement the Xero Reference Data collection.
- [x] Implement Export Batches, Invoice Exports, Invoice Export Entries, Xero Attempts, Xero Webhook Receipts, and Audit Events.
- [x] Add field-level validation for enums, scaled integers, ISO currency codes, IANA timezones, dates, and identifiers.
- [x] Add automatic createdBy and updatedBy attribution where appropriate.
- [x] Mark system-owned fields inaccessible to ordinary create/update APIs.
- [x] Restrict collection and global version-history APIs to owner/admin access.
- [x] Hide Xero accounting token/pending-grant envelopes and safe internal connection state from Payload Admin and ordinary APIs.
- [x] Hide invitation token hashes and delivery diagnostics from ordinary APIs and Payload Admin.
- [x] Hide auth-session hashes, OAuth state/nonce/PKCE material, provider subjects, and identity diagnostic metadata from ordinary APIs.
- [x] Configure Admin labels, title fields, list columns, default sorting, and grouping.
- [x] Add compound and query indexes for:
  - [x] users by email and role;
  - [x] unique invitation token hash, unique normalized email, expiry lookup, and cleanup TTL;
  - [x] unique Auth Identity provider/issuer/subject;
  - [x] unique Auth Identity user/provider;
  - [x] external auth sessions by token hash, user, expiry, and revoked state;
  - [x] unique accounting OAuth state hash plus expiresAt TTL and atomic one-time status transition;
  - [x] unique identity OAuth state hash plus expiry/replay lookup;
  - [x] customers by active state, local name, and Xero ContactID;
  - [x] projects by customer, active state, and code;
  - [x] time entries by user/workDate;
  - [x] time entries by project/workDate;
  - [x] time entries by billingStatus, billable, customer, and workDate;
  - [x] export batches by requestedBy and createdAt;
  - [x] invoice exports by state and createdAt;
  - [x] invoice exports by dispatch state, missing job ID, and age;
  - [x] unique application reference;
  - [x] unique Xero attempt number per invoice export;
  - [x] unique Xero idempotency key across attempts;
  - [x] sparse unique Xero InvoiceID where present;
  - [x] unique export/time-entry allocation;
  - [x] unique webhook event/deduplication identity and pending-receipt age.
- [x] Add custom Mongo index migrations where Payload config cannot express a partial or sparse invariant.
- [x] Add schemaVersion to immutable export snapshots.
- [x] Create wrappers for Payload Local API calls that:
  - [x] default user-context calls to overrideAccess false;
  - [x] require an explicit reason to elevate system operations;
  - [x] propagate the same request/session through transaction-bound calls.
- [x] Create transaction helpers with clear commit/rollback semantics.
- [x] Add data factories for every collection.
- [x] Add transaction/concurrency tests proving one invitation token can create and activate at most one local user.
- [x] Add transaction tests proving identity linking and identity-flow state consumption commit or roll back together.
- [x] Generate Payload TypeScript types and the Admin import map for the implementation changes.
- [x] Create an idempotent seed routine for the initial owner and baseline settings.
- [x] Create migration conventions even though routine Mongo field additions do not require DDL.

### Verification and acceptance

- [x] All collections and globals are available with correct generated types.
- [x] Required core unique and query indexes exist in the isolated local test MongoDB.
- [ ] Required indexes are verified in staging MongoDB.
- [x] Accounting OAuth-state unique/TTL indexes and atomic claims enforce single use and cleanup.
- [x] Invitation unique-token/unique-email and cleanup-TTL indexes enforce their invariants.
- [x] Identity, external-session, and identity OAuth-state indexes enforce their invariants.
- [x] A deliberately failed multi-collection write rolls back completely.
- [x] Sensitive fields cannot be returned through ordinary REST or Admin queries.
- [x] Identity records contain no accounting credentials or tenant connection fields.
- [x] The seed routine can run twice without duplicating data.

## WP-03 — Authentication, Xero sign-in, invitations, roles, and route protection

Depends on: WP-02

Outcome: Invite-only local authentication supports email/password and optional Xero sign-in while keeping identity separate from accounting authority and excluding time-entry users from Admin.

### Email/password and invitation todo

- [x] Keep Payload's built-in email/password strategy enabled alongside the external Xero strategy.
- [x] Use secure HTTP-only authentication cookies and configure secure, same-site behavior for staging and production.
- [x] Build custom email/password login/logout actions that never expose the session token, use generic failure messages, and allow-list post-login paths.
- [x] Route production password-reset delivery through the configured Resend adapter.
- [ ] Enable email verification and verify production password-reset deliverability.
- [x] Enforce an 8-character minimum password, five failed-login limit, and timed lockout.
- [x] Disable public user creation and every self-registration endpoint regardless of login provider.
- [x] Implement one-time owner bootstrap with a tested email/password recovery path, a production first-user form available only while the user collection is empty, and an atomic MongoDB concurrency lock.
- [x] Keep every owner on email/password and reject generic owner demotion, deactivation, and deletion.
- [x] Implement an explicit audited owner-transition command that proves another active password-capable owner remains under concurrent requests.
- [x] Implement owner/admin-driven email/password invitations:
  - [x] keep a private pending Invitation rather than creating an inactive user with a temporary password;
  - [x] generate and store only a SHA-256 hash of a high-entropy, single-use, seven-day setup token;
  - [x] provide adapter-neutral invitation mail plus an explicit manual development-delivery mode;
  - [x] route production invitation delivery through the configured Resend adapter;
  - [ ] verify branded invitation delivery from the production sender domain;
  - [x] allow acceptance by email/password;
  - [x] allow acceptance by the bound Xero identity flow;
  - [x] create and activate the local user only after successful acceptance;
  - [x] claim and invalidate the token atomically so concurrent acceptance creates one user;
  - [x] support token-rotating resend and reasoned revoke.
- [x] For Xero-based invite acceptance, require both the valid invitation context and the Xero callback; matching email alone is never sufficient.
- [x] Require the normalized invited email to match the verified Xero email, or stop for explicit owner/admin review rather than silently changing the invitation.
- [x] Assign the email/password invitee's role, active state, and timezone exclusively from the local invitation/Admin action.
- [x] Add display name, role, active state, and timezone to the local user profile.
- [x] Add enabled login methods and last login provider once external identities exist.
- [x] Default an invitation's timezone from Business Settings while allowing the issuer and later user to select another valid IANA timezone.
- [x] Prevent users from changing their own role or active state.
- [x] Prevent generic suspension, demotion, deletion, or password removal for owners; leave future owner transitions to the explicit guarded command above.
- [x] Ensure password-reset requests return the same response whether an arbitrary email address exists.
- [x] Mask invitation email addresses on the public token-preview page and return generic invalid/expired/revoked token failures.

Implementation note (18 July 2026): account email delivery defaults to `manual`, so development can exercise invitation acceptance without treating Payload's non-delivering console fallback as successful delivery. In manual mode the public forgot-password endpoint is denied before token generation and the custom request page returns a generic response. `resend` mode requires an API key, valid sender address, and single-line sender name at startup, initializes Payload's `resend-rest` adapter, and refuses to generate or mark account mail delivered if that adapter is absent. Authentication/command rate limits and email verification are implemented; sender-domain provisioning and hosted invitation/reset deliverability checks remain external.

### Xero identity sign-in todo

- [x] Use only the dedicated Xero identity client registration and callback for sign-in.
- [x] Request exactly `openid profile email`; reject configuration containing `offline_access`, accounting scopes, or any tenant-scoped permission.
- [x] Use a maintained OpenID Connect client and Xero discovery/JWKS metadata rather than implementing token verification ad hoc.
- [x] Add a correctly branded “Sign in with Xero” action to login and eligible invitation pages.
- [x] Implement a Xero identity start endpoint that:
  - [x] records whether the purpose is sign-in, invite acceptance, or link;
  - [x] generates high-entropy state and nonce values;
  - [x] binds the flow to the initiating browser, local session/invitation, and allow-listed return path;
  - [x] uses PKCE when supported by the selected client/flow;
  - [x] stores sensitive verifier material safely;
  - [x] sets a short expiry and single-use state.
- [x] Implement the identity callback that:
  - [x] rejects OAuth errors with a safe user-facing result;
  - [x] validates state, browser binding, purpose, expiry, and one-time use before account changes;
  - [x] exchanges the authorization code only on the server;
  - [x] validates ID-token signature, issuer, audience, expiry, issued-at, nonce, and required claims;
  - [x] reads the stable issuer/subject pair plus email/name display claims;
  - [x] marks state consumed atomically to prevent replay;
  - [x] rejects unknown, extra, or accounting scopes;
  - [x] discards the authorization code, ID token, and identity access token after validation.
- [x] Never request or store an identity refresh token.
- [x] Never call the Xero Connections or Accounting APIs from an identity callback.
- [x] Resolve returning users by unique issuer/subject, not by email.
- [x] Recheck the local user's active state and current role before creating a session.
- [x] Deny an unknown/uninvited Xero subject without revealing whether the email belongs to an existing account.
- [x] Do not create, merge, move, or link an account merely because a Xero email matches a local email.
- [x] Do not automatically replace the authoritative local email/name when Xero claims change; show the snapshot for explicit profile review.
- [x] Make Xero login optional and keep the email/password entry point available when Xero is unavailable or the feature is disabled.

### Identity linking and local session todo

- [x] Run an implementation spike proving the selected Payload custom strategy and local session design before completing the remaining Xero sign-in UI.
- [x] Implement a Payload custom authentication strategy that validates a hashed opaque External Auth Session and returns the current local user.
- [x] Issue and rotate a local application session only after the Xero callback and local-account checks succeed.
- [x] Never use a Xero ID token or access token as the application's browser session.
- [x] Store only a hash of the opaque external session token and send the raw value only in a secure HTTP-only cookie.
- [x] Define idle/absolute expiry, rotation, revocation, device display, and cleanup behavior for external sessions.
- [x] Apply the same CSRF, origin, cookie, and session-fixation protections to both login methods.
- [x] Build an account-security page listing enabled login methods, linked Xero identity display data, and active local sessions without exposing provider subject or token data.
- [x] Require a recently authenticated local session before linking Xero to an existing user.
- [x] Require explicit confirmation and enforce unique issuer/subject and one-Xero-identity-per-user constraints.
- [x] Never silently transfer a Xero identity between local users; provide a reasoned, audited owner recovery process for genuine collisions.
- [x] Permit unlink only when another usable login/recovery method remains, and require recent authentication plus confirmation.
- [x] Do not log the user out of Xero or disconnect the business accounting integration when logging out or unlinking locally.
- [x] Revoke Payload sessions on local password change/reset and user deactivation.
- [x] Revoke both Payload and External Auth Sessions on global logout, credential compromise, or relevant Xero identity recovery once external sessions exist.
- [x] Add a custom profile page for display name and IANA timezone selection.
- [x] Extend the account area with a current-password-confirmed password-change flow that rotates the current session and revokes the others.
- [x] Extend the account area with Xero link/unlink and active-session management.
- [x] Document an audited recovery procedure for loss of access to the only owner account and for a compromised external identity link.
- [x] Audit invitation, acceptance provider, identity link/unlink/collision/recovery, login provider, role change, deactivation, password reset, and session revocation without storing tokens.
- [x] Rate-limit email login, Xero start/callback failures, forgot-password, reset, invite acceptance, verification, link, and unlink operations.
- [x] After a successful login, optionally enqueue a non-blocking stale accounting-connection health check that uses only the existing server-held accounting credential.
- [x] Ensure the health check can neither delay nor fail login and receives no identity-flow token or code.

### Authorization and route-protection todo

- [x] Add authorization helpers that fail closed for unknown roles and operate identically for both login methods.
- [x] Deny Payload Admin to member and biller roles.
- [x] Permit Payload Admin only to owner and admin.
- [x] Protect custom application route groups by local authentication.
- [x] Protect billing routes to owner, admin, and biller.
- [x] Protect the accounting settings page and every accounting connection mutation with local owner/admin authorization.
- [x] Protect identity recovery and release/rebill actions when those workflows are implemented.
- [x] Ensure local roles—not Xero claims, Xero organisation permissions, or accounting authorizer identity—control every route and field.
- [x] Ensure deactivated users lose Payload sessions and cannot create a new email/password session.
- [x] Ensure deactivated users cannot refresh a future External Auth Session.

### Verification and acceptance

- [x] Owner/admin can invite and deactivate users; an invitation can be accepted once by email/password.
- [x] A bound invitation can be accepted through the future Xero identity flow.
- [x] An uninvited Xero user cannot register, and matching email alone cannot link or take over an account.
- [x] A returning user is resolved by issuer/subject and receives the same local role regardless of current Xero email or organisation access.
- [x] Identity login requests only identity scopes and persists no Xero identity token.
- [x] Xero sign-in cannot read or mutate the business tenant, accounting tokens, scopes, connection health, or export state.
- [x] State/nonce/code replay, wrong browser, wrong purpose, wrong issuer/audience, expiry, email mismatch, duplicate subject, collision, and open-redirect tests pass.
- [x] Session fixation, rotation, expiry, unlink, suspension, role change, and global-revocation tests pass for both login methods.
- [x] Email/password login remains operational while Xero sign-in is disabled or unavailable.
- [x] An email/password member receives no Payload Admin or financial access.
- [x] A member can use Xero sign-in and retain the same local restrictions.
- [x] A biller can access billing screens but receives no Payload Admin access.
- [x] Members cannot read rates, billing settings, export records, Xero data, or other users' time.

## WP-04 — Admin foundation and application settings

Depends on: WP-02, WP-03

Outcome: Owner/admin users can safely configure the business and billing behavior without gaining generic access to protected system state.

### Todo

- [x] Brand the Payload Admin and provide navigation groups for People, Customers, Projects, Billing, Xero, and Operations.
- [x] Hide internal Payload job and protected system collections unless a diagnostic view explicitly exposes safe fields.
- [x] On user detail, show safe login-method status, last login provider/time, linked-Xero display name/email snapshot, and active local-session count.
- [x] Do not expose raw provider subject, OAuth state/nonce/verifier, authorization code, ID/access token, session token/hash, or accounting credential in Admin.
- [x] Add owner/admin controls to revoke a linked identity or user sessions only through the protected WP-03 recovery commands with confirmation and audit reason.
- [x] Use unambiguous accounting UI language and explain that the business connection is separate from optional Xero user sign-in.
- [x] Show identity-login health separately from accounting-connection health so an incident in one is not presented as failure of the other.
- [x] Configure Business Settings fields:
  - [x] business name;
  - [x] default timezone;
  - [x] base currency;
  - [x] locale/date/time display preferences.
- [x] Configure Authentication Settings fields:
  - [x] independent Xero identity-login feature flag;
  - [x] staged rollout roles/groups;
  - [x] identity-linking and invite-acceptance switches;
  - [x] external-session lifetime;
  - [x] stale accounting-health-check threshold.
- [x] Prevent authentication settings from disabling email/password or the final owner's tested recovery path.
- [x] Configure Billing Settings fields:
  - [x] default revenue account;
  - [x] default tax type;
  - [x] line amount type;
  - [x] due-date terms;
  - [x] reference prefix;
  - [x] line-description template;
  - [x] background versus wait-for-result execution;
  - [x] allow biller override, default false;
  - [x] size threshold that forces background execution.
- [x] Label the synchronous mode “Wait for Xero,” not “instant.”
- [x] Explain in Admin help text that both modes use the same durable job and that wait mode may continue in the background.
- [x] Make export-mode changes apply only to future export batches.
- [x] Validate account/tax selections against the currently connected Xero tenant once reference data is available.
- [x] Prevent configuration changes from rewriting historical Time Entry snapshots.
- [x] Apply the same immutability rule to Invoice Export snapshots when those collections are implemented.
- [x] Add safe defaults while leaving Xero-dependent settings visibly incomplete until connection.
- [x] Add an Admin dashboard showing:
  - [x] active users;
  - [x] unmapped customers;
  - [x] unbilled entry count;
  - [x] Xero connection health;
  - [x] queued/action-required/manual-review export counts.
- [x] Add audit events for every business, billing, role, and execution-mode setting change.
- [x] Audit security-sensitive settings automatically and display the actor and last-change timestamp.

### Verification and acceptance

- [x] Only owner/admin can change settings.
- [x] Xero identity sign-in can be independently disabled without changing accounting settings or existing export processing.
- [x] A settings change affects new previews but not saved export snapshots.
- [x] Invalid Xero settings block export with an actionable message.
- [x] The Admin dashboard contains no tokens or sensitive payloads.
- [x] Identity/session recovery controls cannot mutate the business Xero Connection.

## WP-05 — Xero accounting OAuth connection and reference data

Depends on: WP-01, WP-02, WP-03, WP-04

Outcome: A secure, maintainable business accounting grant connects exactly one pinned Xero organisation, refreshes independently of user login, and supports controlled authorizer handover.

Implementation note (2026-07-18): the accounting connection, rotating encrypted grant, reference cache, stale-login and scheduled health checks, immutable audit trail, ambiguous-export disconnect guard, same-authorizer reconnect, and validated authorizer handover are implemented. Automated rollback/concurrency tests prove wrong-tenant, wrong-capability, and duplicate callbacks preserve the old grant. Current Xero pricing/connection limits are recorded below. Live Demo Company authorization, a named backup operator, and hosted log/monitoring review remain external.

### Accounting client and initial connection todo

- [x] Use only the dedicated Xero accounting client registration, secret, and callback for this package.
- [x] Let an owner/admin save or replace the client ID and write-only encrypted client secret in the application after confirming their current password.
- [x] Show the exact environment-specific callback URI in the application; do not require an accounting environment variable, restart, or redeploy.
- [x] Register the minimum required accounting scopes:
  - [x] offline_access;
  - [x] accounting.invoices;
  - [x] accounting.contacts because explicit contact creation is supported;
  - [x] accounting.settings.read.
- [x] Do not request `openid`, `profile`, `email`, or other identity scopes from the accounting client.
- [x] Ensure the accounting callback never creates an application user, links an Auth Identity, or creates/revokes an application session.
- [x] Ensure the identity callback cannot read or write Xero Connection, call the Connections API, select a tenant, or invoke the accounting token service.
- [x] Use the standard Authorization Code connection; do not use Xero Custom Connections.
- [x] Reconfirm Xero's current developer-app pricing and connection allowance before staging and production launch.
  - Checked against Xero's official pricing and OAuth-limit pages on 18 July 2026: new apps default to Starter, which is free for up to five connections and has a 1,000-call daily limit per connected tenant; Core is AUD 35/month excluding tax for up to 50 connections and a 5,000-call daily limit per connected tenant.
  - This single-business design needs one accounting-tenant connection and is within Starter's published allowance. Xero says some bespoke single-client integrations may be exempt from its commercial model, but exemption is determined by Xero; confirm the app's actual tier in the Developer Portal and recheck the linked pricing page at launch.
- [x] Implement an owner/admin-only “Connect Xero organisation” action requiring current local-password confirmation.
- [x] Generate high-entropy accounting OAuth state in OAuth Flow States, bind it to the initiating user/browser and operation, set a short expiry, and enforce one-time use with an atomic claim.
- [x] Build the authorization URL using the exact accounting callback derived from the trusted application origin; the route is structurally distinct from the identity callback.
- [x] Implement the accounting callback:
  - [x] validate flow family, purpose, state, user/browser binding, expiry, and one-time use before exchanging the code;
  - [x] exchange the authorization code server-side with the accounting client only;
  - [x] validate the exact granted accounting scopes and reject identity scopes/ID tokens;
  - [x] verify the signed access token issuer, audience, client binding, authorizing Xero user, and authentication event;
  - [x] fetch and locally filter connections for the current authentication event;
  - [x] let owner/admin explicitly select the intended organisation if several were authorized;
  - [x] on first connection, persist and pin tenant/connection identity;
  - [x] encrypt tokens before persistence;
  - [x] record local initiator, Xero authorizer, authentication event, scopes, and expiry;
  - [x] consume the state and remove encrypted pending-grant/candidate data on completion.
- [x] Reject non-accounting-family state at the accounting callback even when its state/code shape otherwise appears valid.
- [x] Treat accounting credentials as business integration credentials, not as login credentials or ownership of the local user account.

### Accounting token lifecycle todo

- [x] Encrypt accounting tokens with a dedicated versioned AES-256-GCM key derived from `PAYLOAD_SECRET` under an accounting-token HKDF purpose separate from the client-secret configuration purpose and external-auth storage.
- [x] Never decrypt tokens in a broad afterRead hook.
- [x] Implement a narrow `server-only` accounting token service with no identity/authentication imports or inputs.
- [x] Serialize rotating refresh-token use with an atomic connection-level lease and optimistic token version.
- [x] Persist both new access and refresh token envelopes atomically after refresh.
- [x] Retain the old refresh-token envelope after an uncertain/retryable refresh result so the documented grace retry remains possible.
- [x] Refresh before an accounting API call whenever the access token is near expiry.
- [x] Schedule a low-frequency proactive refresh/health check well before the refresh token's inactivity limit even when no exports occur.
- [x] Allow a successful application login to enqueue that same health check only when stale, using the existing encrypted accounting grant.
- [x] Make the login-triggered health check asynchronous, best-effort, deduplicated, and unable to affect login success or latency.
- [x] Keep accounting service inputs structurally separate from identity authorization codes, ID/access tokens, subjects, and identity-flow state.
- [x] Show an action-required/reconnect state after a terminal refresh failure without deleting tenant identity or historical mappings.

### Disconnect, reconnect, and authorizer-handover todo

- [x] Complete safe owner/admin disconnect across the later export/audit model:
  - [x] block or require resolution while an export has an ambiguous Xero outcome;
  - [x] attempt both remote connection deletion and refresh-token revocation where credentials permit;
  - [x] retain tenant/connection identity and leave room for historical invoice mappings;
  - [x] clear all locally usable accounting credential envelopes even when remote cleanup cannot be confirmed;
  - [x] mark the connection disconnected and surface incomplete remote cleanup;
  - [x] record the latest actor and mandatory reason on the protected connection record;
  - [x] emit an immutable Audit Event when that collection exists.
- [x] Keep accounting disconnect/reconnect code isolated from Auth Identities and application-session revocation.
- [x] Ensure local email/password logout never changes accounting connection state.
- [x] Verify future Xero identity unlink/revocation also leaves accounting connection state unchanged.
- [x] Implement reconnect against the already pinned tenant ID.
- [x] Require exact pinned-tenant match; never select the first returned organisation or silently switch tenants.
- [x] Treat authorization by a different Xero user as an explicit accounting-authorizer handover.
- [x] For handover:
  - [x] require owner/admin capability, recent local reauthentication, a reason, and high-impact confirmation;
  - [x] block cutover while exports have unresolved ambiguous outcomes;
  - [x] validate new scopes, tenant, organisation capability, and connection health before changing the active credential;
  - [x] keep the old credential active until validation succeeds;
  - [x] atomically switch the credential-lineage version and provenance;
  - [x] retain safe old/new authorizer and connection lineage in audit history;
  - [x] revoke the obsolete credential/connection only after verified cutover.
- [x] Abort and retain the working connection when validation, tenant match, or atomic cutover fails.
- [x] Warn operators when the local account associated with the current accounting authorizer is suspended or scheduled to leave, without silently disconnecting Xero.
- [ ] Nominate and document a backup owner/admin capable of controlled reauthorization before launch.
- [x] Block silent switching to another tenant; a future intentional tenant migration requires a separate scoped plan and mapping remediation.

### Reference-data and Admin todo

- [x] Fetch Organisation and Organisation Actions after connection.
- [x] Verify CreateDraftInvoice permission and supported organisation plan.
- [x] Fetch and cache active accounts, tax rates, currencies, and other fields needed for invoice configuration.
- [x] Filter the account selector to appropriate active revenue/sales accounts.
- [x] Refresh reference data:
  - [x] after connection or handover;
  - [x] on demand from Admin;
  - [x] on a safe periodic schedule;
  - [x] after mapping validation failures.
- [x] Add an owner/admin accounting-connection page showing tenant/connection identity, status, scopes, Xero authorizer/local initiator IDs, authorization date, last refresh/health check, and connect/reconnect/health/disconnect actions.
- [x] Add the controlled handover action and show last successful API time when the broader operations UI is implemented.
- [x] Keep accounting connection health explicitly labelled as separate from optional Xero user sign-in.
- [x] Redact accounting tokens, authorization codes, state/binding values, client secrets, and provider response bodies from logs, errors, traces, UI, and ordinary Payload access.
- [x] Wrap Xero HTTP operations behind an application interface so automated tests do not depend on live Xero.
- [x] Use the current granular accounting scopes rather than deprecated broad scopes.

### Verification and acceptance

- [ ] Local/staging completes accounting authorization against the Xero Demo Company using the accounting client only.
- [x] Automated tests reject accounting state replay, wrong local user/browser binding, missing/expanded/identity scopes, ID tokens, malformed connection/token responses, and unsafe provider error detail.
- [x] Add explicit automated expiry, wrong-flow, reconnect wrong-tenant, callback-denial, and terminal/uncertain refresh cases.
- [x] Concurrent simulated API calls perform one rotating refresh and return the same persisted successor token without corruption.
- [x] A same-authorizer reconnect and different-authorizer handover both preserve the pinned tenant and historical records.
- [x] A failed or wrong-tenant handover leaves the previous working accounting credential active and unchanged.
- [x] Xero identity sign-in, logout, link, and unlink leave accounting tenant, scopes, connection, token ciphertext, and export state unchanged.
- [x] Accounting connect, disconnect, reconnect, and handover leave local users, Auth Identities, and application sessions unchanged.
- [x] A login-triggered health check uses only the stored accounting credential and cannot fail or delay login.
- [x] Account, tax, currency, and organisation capability data appears in Admin.
- [x] Disconnect tests prove usable local credential envelopes are removed while pinned tenant/connection identity is retained.
- [x] Re-run disconnect preservation against historical export records once those collections exist.
- [x] Current tests prove plaintext credentials are absent from persisted connection/state documents, private collections deny ordinary access, and provider error bodies are redacted.
- [ ] Verify production logs/traces/error monitoring and future Admin/audit/export surfaces contain no credential, provider subject, or authorization artifact.

## WP-06 — Customers, Xero contact mapping, projects, and rates

Depends on: WP-04, WP-05

Outcome: Privileged users can manage local customers/projects, select contacts already created in Xero, explicitly create missing contacts, and maintain stable project billing rates.

### Customer and contact todo

- [x] Implement local customer create, edit, archive, and search flows in Payload Admin.
- [x] Prefer archive over deletion.
- [x] Disable generic customer deletion (including when referenced).
- [x] Permit an unmapped local customer to have projects and time entries, but block invoice export until mapping is valid.
- [x] Add a sparse unique index on Xero ContactID so a Xero contact cannot map to two local customers.
- [x] Keep local editable fields separate from Xero snapshot fields so synchronisation cannot overwrite local notes or naming unexpectedly.
- [x] Build a server-only Xero contact search service with pagination and bounded queries.
- [x] Add an owner/admin “Select from Xero” interface.
- [x] Show contact name, email, contact number, active/archive state, and existing local mapping.
- [x] Support “Import as new customer” from a selected Xero contact.
- [x] Support “Link this customer” for an existing unmapped local customer.
- [x] Detect an already-linked ContactID and link to the existing local record from the validation message.
- [x] Add an explicit owner/admin “Create contact in Xero” action:
  - [x] validate required local customer fields;
  - [x] preview the exact contact payload;
  - [x] require confirmation;
  - [x] persist an application idempotency/reference record;
  - [x] create the contact server-side;
  - [x] store the returned ContactID atomically;
  - [x] reconcile an uncertain timeout before retrying.
- [x] Do not create Xero contacts implicitly during invoice export.
- [x] Add manual contact refresh and periodic lightweight status refresh.
- [x] Detect archived, merged, missing, or inaccessible Xero contacts.
- [x] Never remap a contact by matching its name.
- [x] Add a guarded “Change Xero link” action with a mandatory reason and warning when historical invoices exist.
- [x] Display mapping state badges and actionable errors in customer lists/forms.
- [x] Restrict all Xero contact search/create/remap operations to owner/admin.

### Project and rate todo

- [x] Implement local project create, edit, archive, and search flows.
- [x] Require a customer relationship, name, currency, and non-negative hourly rate.
- [x] Store hourly rate as a scaled integer supporting the agreed Xero precision.
- [x] Format scaled rates safely in Admin without binary floating-point calculations.
- [x] Validate project currency against customer currency.
- [x] Define project-code normalization and uniqueness.
- [x] Allow optional project overrides for revenue account, tax type, and Xero tracking values.
- [x] Display inherited versus overridden settings clearly.
- [x] Snapshot the project rate, currency, project name/code, and customer onto each new time entry.
- [x] Make the time-entry rate snapshot invisible to members.
- [x] Make later project rate changes affect only newly created entries by default.
- [x] Add an explicit owner/admin action to recalculate selected unbilled entries when a commercial rate change should apply retrospectively.
- [x] Preview the affected count/value and require confirmation before recalculation.
- [x] Never recalculate reserved or exported entries.
- [x] Warn before rate/currency/account/tax changes when unbilled entries exist.
- [x] Enforce the customer/project currency boundary and reject customer currency changes once projects exist.
- [x] Prevent archived projects or customers from receiving new time while keeping historical entries readable.
- [x] Disable generic project deletion.
- [x] Audit customer mapping, customer status, project status, rate, currency, account, tax, and tracking changes.

### Verification and acceptance

- [x] Owner/admin can import a contact already created in Xero.
- [x] Owner/admin can link an existing local customer or explicitly create a missing Xero contact.
- [x] Duplicate or name-based contact mappings cannot occur silently.
- [x] Members cannot search Xero or view/change mappings and rates.
- [x] Project-rate parsing, scaled arithmetic, and display-format tests pass.
- [x] Rate changes never rewrite reserved/exported data or historical export snapshots.
- [x] Archived projects remain visible historically but cannot receive new entries.

## WP-07 — Manual time-entry domain and member UI

Depends on: WP-03, WP-06

Outcome: Members can record completed work either as a local start/finish range or as hours/minutes, with no running timer.

### Domain and validation todo

- [x] Implement exactly two input modes: range and duration.
- [x] Use minute precision throughout V1; reject seconds and fractional minutes.
- [x] For range mode require:
  - [x] work date as part of the local start/finish values;
  - [x] timezone;
  - [x] local start time;
  - [x] local finish time or explicit next-day finish.
- [x] Convert local times to unambiguous UTC instants using a tested IANA/Intl timezone converter.
- [x] Calculate range duration from submitted UTC instants.
- [x] Derive workDate from the start in the entry timezone.
- [x] Support intervals crossing midnight by accepting explicit start/end instants.
- [x] Reject nonexistent daylight-saving local times.
- [x] Reject a repeated daylight-saving wall time rather than guessing an offset; add an explicit earlier/later offset choice only if product use requires entering that rare range rather than duration.
- [x] For duration mode require:
  - [x] work date;
  - [x] timezone;
  - [x] whole hours and minutes;
  - [x] no start/end timestamps.
- [x] Convert both modes to canonical positive durationSeconds divisible by 60.
- [x] Define and enforce a 24-hour maximum duration per entry.
- [x] Require a project and a non-empty description for every entry.
- [x] Derive customer from the selected project and validate it server-side.
- [x] Default billable from the project while allowing the member to change it.
- [x] Snapshot user timezone, project/customer identity, currency, and current project rate on create.
- [x] Preserve an entry's timezone snapshot when the user later changes preference.
- [x] Detect likely duplicate and overlapping range entries and show a warning; do not silently discard input.
- [x] Allow members to create, update, duplicate, and delete only their own unbilled entries.
- [x] Allow owner/admin to correct unbilled entries with an audit reason.
- [x] Prevent all generic edits/deletes of reserved or exported entries.
- [x] Prevent clients from writing derived customer, duration, rate, and billing-status fields.
- [x] Add and protect the current export allocation once the export collections exist.
- [x] Audit privileged corrections and deletion.

### Custom application todo

- [x] Build a custom authenticated application shell separate from Payload Admin.
- [x] Route members to the time-entry area after login.
- [x] Build the time-entry form with a clear “Start and finish” versus “Hours and minutes” switch.
- [x] Default timezone from the user profile.
- [x] Provide a searchable IANA timezone selector for the profile and each entry.
- [x] Display the current UTC offset, especially around daylight-saving changes.
- [x] Build an active, billing-eligible project selector with the customer derived from project.
- [x] Show calculated duration before saving a range entry.
- [x] Preserve form data and focus when server validation fails.
- [x] Build daily, weekly, and all-time views with previous/current/next period navigation.
- [x] Paginate the recent-time view so members can reach every historical entry without Payload Admin.
- [x] Show date, customer, project, description, input mode, duration, billable state, and billing state.
- [x] Add date, project, billable, and billing-state filters that persist through pagination.
- [x] Add a customer filter without exposing private customer billing fields.
- [x] Display exact daily/weekly duration totals across the full filtered result without exposing rates to members.
- [x] Add edit, duplicate, and delete actions only when allowed.
- [x] Explain why a reserved/exported entry is locked.
- [x] Link privileged users from a locked entry to its export record.
- [x] Make the primary entry/list flows usable with keyboard, mobile, and desktop.
- [x] Add complete loading, empty, offline/network-error, permission, and expired-session states.
- [x] Do not implement start, stop, pause, elapsed-time polling, or any running-timer endpoint in V1.

### Verification and acceptance

- [x] Unit tests cover ordinary, cross-midnight, DST-gap, and repeated-time range calculations.
- [x] Automated duration-mode validation and conversion tests cover zero, normal, and over-24-hour values.
- [x] A profile timezone change leaves existing entries unchanged.
- [x] Customer/project consistency is enforced through UI, REST, and Local API.
- [x] Members cannot create time for another user or alter another user's entry.
- [x] Reserved/exported entries cannot be changed by generic APIs.
- [x] End-to-end tests cover both input modes, validation recovery, timezone selection, filtering, duplication, editing, and deletion.
- [x] Implemented source contains no running-timer behavior; the member login/profile/list/filter/form/edit/duplicate/delete slice is covered by browser tests.

## WP-08 — Billing eligibility, filters, and selection

Depends on: WP-04, WP-06, WP-07

Outcome: Biller/admin/owner can select explicit entries or all eligible unbilled entries matching an optional filter, with exact totals and visible blockers.

### Eligibility todo

- [x] Implement one shared server-side eligibility service used by count, list, preview, and confirmation.
- [x] Define an eligible entry as:
  - [x] billable;
  - [x] unbilled;
  - [x] positive whole-minute duration;
  - [x] valid project/customer relationship;
  - [x] positive rate and valid currency snapshot;
  - [x] valid active Xero contact mapping;
  - [x] resolvable revenue account, tax type, and required tracking;
  - [x] not already reserved by another export.
- [x] Keep historical entries eligible when the source project/customer is archived, provided financial mappings remain valid.
- [x] Return structured blocker codes and remediation links.
- [x] Cover at least unmapped/archived contact, missing rate, currency conflict, missing account/tax/tracking, invalid duration, stale source data, and active reservation.
- [x] Apply deterministic ordering by customer, currency, workDate, project, user, and entry ID.
- [x] Calculate totals with integer/scaled arithmetic.
- [x] Never expose rate/amount data to members.

### Selection todo

- [x] Support explicit selected time-entry IDs.
- [x] Support all eligible entries matching a normalized filter, with explicit exclusions.
- [x] Permit an explicit unfiltered “all eligible unbilled” selection; show its full count, oldest/newest dates, totals, and invoice groups before confirmation.
- [x] Warn on large or unbounded selections, force background execution above the configured threshold, and block only when a Xero field/line/payload limit requires a narrower selection.
- [x] Ensure “all matching” covers the complete result set, not only the visible page.
- [x] Save normalized filter semantics, timezone, sort, exclusions, and selection type for audit.
- [x] Re-resolve IDs/filter and recheck eligibility at preview and confirmation.
- [x] Reject stale or unauthorized IDs rather than silently dropping them.
- [x] Group the prospective result by Xero contact and currency to show invoice count.

### Billing queue UI todo

- [x] Build a custom billing queue for owner/admin/biller.
- [x] Add work-date, customer, project, user, currency, and blocker filters.
- [x] Show date, user, customer, project, complete description, duration, rate, amount, and mapping state.
- [x] Add row, page, and all-filtered selection plus exclusion/clear actions.
- [x] Keep selected count, minutes, value, and invoice count visible while paging.
- [x] Add an “All uninvoiced” shortcut that includes every eligible unbilled entry and always proceeds through preview.
- [x] Separate eligible and blocked entries rather than silently omitting blocked rows.
- [x] Give every blocked row an actionable explanation.
- [x] Warn when selected data changes between queue and preview.
- [x] Handle empty, large, stale, concurrent, loading, and partial-error states.

### Verification and acceptance

- [x] Every eligibility/blocker rule has unit tests.
- [x] Explicit, page, all-filtered, and exclusion selection semantics have integration tests.
- [x] “All uninvoiced” excludes non-billable, reserved, exported, and blocked entries.
- [x] Totals remain exact across mixed minutes and rates.
- [x] Selections remain correct across pagination.
- [x] Role tests prove members have no billing access.
- [x] End-to-end tests cover selected and all-filtered flows.

## WP-09 — Invoice preview, immutable snapshots, and reservation

Depends on: WP-05, WP-08

Outcome: The user sees the exact Xero drafts before confirmation; confirmation atomically reserves time and saves one immutable line mapping per entry.

### Preview construction todo

- [x] Group entries into one prospective invoice per Xero ContactID and currency.
- [x] Generate exactly one Xero line per time entry; do not aggregate entries by project, rate, date, or user.
- [x] Include the full time-entry description in every line description.
- [x] Define a configurable default line template that also identifies work date and project while preserving the user's description.
- [x] Resolve line quantity from durationSeconds through one exact-decimal policy.
- [x] Resolve unit amount from the time-entry rate snapshot.
- [x] Resolve account, tax, and tracking using project overrides followed by Billing Settings.
- [x] Set invoice type to ACCREC and status to DRAFT.
- [x] Set invoice/due dates, reference, currency, and line amount type.
- [x] Add a unique application reference that supports reconciliation.
- [x] Validate contact state, organisation capability, account, tax, currency, tracking, field lengths, and payload size before confirmation.
- [x] Make any truncation or formatting visible; do not silently alter descriptions.
- [x] Show invoice header, every source entry/line, quantity, rate, subtotal, tax, and total.
- [x] Link preview lines to source entries where authorized.
- [x] Produce a preview checksum covering entry versions and all resolved billing settings.
- [ ] Run a Xero Demo Company precision spike for one-minute and representative hour/minute quantities.
- [x] Document unavoidable Xero boundary rounding and ensure the UI preview matches it.

### Confirmation and reservation todo

- [x] Reject a stale preview if any entry, rate snapshot, contact mapping, or billing setting changed.
- [x] Begin one MongoDB transaction.
- [x] Re-query selected entries and verify access/eligibility.
- [x] Conditionally move entries from unbilled to reserved.
- [x] Fail an entire customer/currency group if any entry cannot be reserved.
- [x] Create the Export Batch.
- [x] Create one Invoice Export per customer/currency.
- [x] Create one Invoice Export Entry per time entry with:
  - [x] source entry ID;
  - [x] stable line ordinal;
  - [x] work date/timezone;
  - [x] user/project/customer snapshots;
  - [x] full description;
  - [x] duration/quantity;
  - [x] rate/currency;
  - [x] account/tax/tracking;
  - [x] exact calculated amounts.
- [x] Save sanitized Xero request payloads, hashes, application references, and the initial immutable Xero Attempt/idempotency key.
- [x] Set currentExport on each reserved entry.
- [x] Save each new Invoice Export in preparing state with a durable queue-pending marker.
- [x] Commit the reservation, immutable snapshots, and dispatch intent before creating jobs or making any Xero request.
- [x] After commit, queue one Payload job per Invoice Export, attach its job ID, and atomically move the export to queued.
- [x] Add an idempotent dispatcher/sweeper that finds preparing exports without a job and attaches one.
- [x] Keep entries reserved and surface a retryable dispatch error if job attachment fails; never silently discard or release the export intent.
- [x] Roll back all local changes if snapshot/reservation creation fails.
- [x] Permit preview cancellation without modifying any billing state.

### Concurrency and immutability todo

- [x] Enforce one active export allocation per time entry using conditional writes plus indexes.
- [x] Ensure two simultaneous confirmations cannot reserve the same entry.
- [x] Make saved line/export snapshots immutable through generic CRUD.
- [x] Keep time reserved after a caller timeout until the export outcome is known.
- [x] Make duplicate job attachments harmless even if the dispatcher and request path race.
- [x] Add a controlled repair diagnostic for impossible partial local states.

### Verification and acceptance

- [x] Every selected entry produces exactly one preview and saved invoice line.
- [x] Every line contains the source description and durable entry mapping.
- [x] Grouping is only by contact/currency.
- [ ] Quantity, rate, tax, and total calculations match Xero Demo Company behavior.
- [x] Stale previews are rejected with a useful refresh action.
- [x] Real Mongo replica-set concurrency tests prove an entry cannot be reserved twice.
- [x] Source edits after confirmation cannot change export snapshots.
- [x] A process crash immediately after reservation commit is recovered by the dispatcher without losing the export or creating two invoices.

## WP-10 — Xero export execution and Payload jobs

Depends on: WP-05, WP-09

Outcome: Both Admin-selectable modes execute the same durable, idempotent export job, normally completing background work within one minute.

### Execution-mode todo

- [x] Store xeroExportMode in Billing Settings as background or wait-for-result.
- [x] Default to background.
- [x] Save requestedMode and actualExecution on each batch/export.
- [x] Always create a persisted Payload job, regardless of mode.
- [x] For background mode, return after reservation and dispatch intent are committed; show preparing or queued according to whether job attachment has completed.
- [x] For wait-for-result mode, invoke the created job by ID and wait for its result.
- [x] If wait mode exceeds a short UI/request threshold, show “Continuing in background”; do not cancel the job.
- [x] Force large/multi-invoice exports into background mode according to the documented threshold.
- [x] Make mode changes affect only future batches.
- [x] Keep allowBillerModeOverride false in V1 unless explicitly enabled by owner/admin.
- [x] If enabled later, record the per-export override actor and reason.

### Payload job/workflow todo

- [x] Define a typed CreateXeroInvoice task or workflow.
- [x] Pass only Invoice Export ID as job input; load the immutable payload server-side.
- [x] Send exactly one Invoice Export per Xero mutation request so one invalid invoice cannot create a partially successful multi-invoice response.
- [x] Enable concurrency control and serialize Xero work for the one tenant conservatively.
- [x] Configure bounded attempts and backoff.
- [x] Make the handler application-idempotent independently of Payload job state.
- [x] Atomically claim an export with a bounded processing lease; a runner that does not own the lease cannot send it.
- [x] Before calling Xero:
  - [x] load the export;
  - [x] no-op if already succeeded/released;
  - [x] reject changed payload hashes;
  - [x] ensure entries remain reserved to this export;
  - [x] acquire connection/token refresh lock;
  - [x] refresh Xero accounting OAuth tokens if needed.
- [x] Move state from queued to processing atomically.
- [x] Create or load the immutable Xero Attempt before sending and conservatively persist requestMayHaveBeenSent as true immediately before initiating the network call.
- [x] Validate every Xero idempotency key against the current documented length/format limit before persisting it.
- [x] POST the saved invoice payload with Xero tenant header and Idempotency-Key.
- [x] Use the current granular scopes and Xero SDK/API version.
- [x] Capture attempt timing, HTTP classification, Xero correlation ID, and rate-limit headers without storing secrets.
- [x] On success:
  - [x] verify response invoice/contact/currency/line count;
  - [x] save InvoiceID, InvoiceNumber, URL when available, remote status, and safe response metadata;
  - [x] map returned LineItemIDs by saved ordinal;
  - [x] atomically mark all reserved entries exported;
  - [x] mark export succeeded;
  - [x] write audit events.
- [x] On a definite Xero validation failure:
  - [x] mark action-required with structured remediation;
  - [x] release reservations only when the request definitely did not create an invoice;
  - [x] preserve the failed snapshot/history.
- [x] On 429:
  - [x] honor Retry-After;
  - [x] pause or defer further tenant work until the safe retry time;
  - [x] set retry-wait;
  - [x] retry without changing payload/idempotency identity.
- [x] On 401, perform at most one concurrency-safe token refresh/retry before requiring reconnection.
- [x] On temporary 5xx/network failure proven to be before send, use bounded exponential backoff with jitter.
- [x] On timeout/connection loss after possible send, set reconciling and keep entries reserved.
- [x] If Xero confirms creation but the response materially differs from the snapshot, record the remote ID, keep entries locked, and enter manual-review rather than posting again.
- [x] Never blindly issue a new POST after Xero's idempotency-cache window.
- [x] Treat job completion status as orchestration only; use Invoice Export state for billing truth.

### Vercel job runner todo

- [x] Configure a dedicated xero queue.
- [x] Do not use Payload autoRun on Vercel.
- [x] Add a secured Payload job-run endpoint restricted by CRON_SECRET.
- [x] Configure Vercel Pro Cron to invoke the queue at one-minute intervals.
- [x] Configure intentional function max-duration and shorter outbound Xero request timeouts; do not rely on Vercel terminating work cleanly.
- [x] Limit jobs processed per invocation to stay within function and Xero limits.
- [x] Protect against overlapping/duplicate cron invocations.
- [x] Run the prepared-export dispatcher before or alongside ordinary queue work.
- [x] Add manual owner/admin “Run queue now” for diagnostics without bypassing job locks.
- [x] Add stale-processing detection and a safe recovery job.

### Export status UI todo

- [x] Show preparing, queued, processing, retry-wait, action-required, reconciling, succeeded, cancelled, released, and manual-review states.
- [x] Poll persisted status with backoff while a user watches an export.
- [x] Stop polling on terminal states.
- [x] Show Xero invoice number/link on success.
- [x] Show actionable reconnect/mapping/configuration guidance without raw Xero payloads.
- [x] Permit cancellation only while the export is preparing/queued and no attempt may have been sent.
- [x] Cancel and release that export's reservations atomically while retaining its immutable snapshots and audit history.
- [x] Permit safe retry only when the state machine allows it.

### Verification and acceptance

- [ ] Background mode returns promptly and is normally picked up within one minute.
- [x] Wait mode runs the same job and safely continues in background after interruption.
- [x] Double-click, duplicate cron, job retry, and concurrent runner tests create at most one Xero invoice.
- [x] Success marks every mapped entry exported atomically.
- [x] Definite failures never mark time exported.
- [x] Ambiguous failures remain reserved and enter reconciliation.
- [x] 429 and Retry-After behavior is tested.

## WP-11 — Reconciliation, Xero webhooks, and remote status

Depends on: WP-10

Outcome: Uncertain exports are resolved without duplicate invoices, and Xero-side invoice changes are reflected locally without automatically releasing time.

### Reconciliation todo

- [x] Define a typed ReconcileXeroInvoice Payload task.
- [x] Queue reconciliation immediately for ambiguous send/response outcomes.
- [x] Keep the export payload, application reference, original idempotency key, and entries unchanged while reconciling.
- [x] During Xero's idempotency-cache window, permit a retry only with the same method, URL, body, and key.
- [x] Query Xero using the stored InvoiceID when one is known.
- [x] Otherwise query using the unique application reference plus expected contact/date/currency constraints.
- [x] Handle reconciliation results:
  - [x] exactly one matching invoice with matching material values: finalize success;
  - [x] exactly one invoice with material mismatch: manual-review;
  - [x] several plausible invoices: manual-review;
  - [x] confirmed no match while safe retry remains possible: retry-wait;
  - [x] Xero unavailable or inconclusive: remain reconciling with bounded backoff.
- [x] After Xero's idempotency cache expires, never repeat the POST until a targeted read has established that no invoice exists.
- [x] If a new POST is justified after confirmed absence, create a new attempt/key linked to the original export rather than overwriting history.
- [x] Verify contact, currency, reference, line count, line descriptions, quantities, and totals before treating a found invoice as the export result.
- [x] Finalize reconciled success using the same atomic local completion service as a normal successful response.
- [x] Expose a safe owner/admin manual reconciliation action that runs the same service.
- [x] Require a reason for any manual-review resolution.
- [x] Provide explicit owner/admin resolution commands for:
  - [x] accepting and linking one verified existing Xero invoice;
  - [x] confirming absence and authorizing a linked replacement attempt; and
  - [x] leaving the case locked while escalating it.
- [x] Never expose a generic “mark succeeded,” “mark failed,” or direct state editor.
- [ ] Add alerts for exports remaining processing/reconciling beyond operational thresholds.

### Webhook todo

- [ ] Register Xero invoice webhooks for staging and production.
- [x] Receive the raw request body without mutation.
- [x] Validate x-xero-signature with the configured webhook key and constant-time comparison.
- [x] Validate expected content type and payload shape.
- [x] Return 401 for invalid signatures.
- [x] Return a cookie-free successful response within five seconds and queue actual processing.
- [x] Implement Xero's webhook intent-to-receive validation and meet its response-time requirement with automated tests.
- [x] Persist a minimal Xero Webhook Receipt before returning and deduplicate repeated events durably.
- [x] Validate every event tenant ID against the configured single tenant.
- [x] Ignore and alert on an event for another tenant.
- [x] Fetch the authoritative invoice rather than trusting a minimal event as complete state.
- [x] Cope with duplicated and out-of-order update events.
- [x] Persist remote status, update timestamp, last sync, and safe change summary.
- [x] Detect DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED, and DELETED transitions.
- [x] Detect line count/identity/material changes to an exported invoice.
- [x] Mark deleted, voided, or mismatched invoices action-required.
- [x] Never change exported time back to unbilled from a webhook.
- [x] Redact customer descriptions and financial payloads from routine webhook logs.

### On-demand and scheduled maintenance todo

- [x] Add “Refresh from Xero” on invoice export detail.
- [x] Add a periodic status reconciliation for active/recent exports without excessive polling.
- [x] Add scheduled token keepalive/refresh before 60 days of inactivity.
- [x] Add scheduled Xero connection and reference-data health checks.
- [x] Add stale-job recovery that distinguishes a pre-send crash from a possibly-sent request.
- [x] Add an operations view for stuck, retry-wait, reconciling, action-required, and manual-review exports.

### Verification and acceptance

- [x] Webhook signature, wrong-tenant, duplicate, out-of-order, slow-processing, and retry tests pass.
- [x] An ambiguous POST that created an invoice is reconciled without a second invoice.
- [x] A confirmed absent invoice can be retried through a linked attempt.
- [x] A mismatch or multiple matches cannot be auto-resolved.
- [x] Xero-side deletion/voiding becomes visible but does not automatically release entries.
- [x] On-demand and scheduled reconciliation stay inside Xero rate limits.

## WP-12 — Admin release and rebill

Depends on: WP-11

Outcome: Owner/admin can explicitly release the entries of a verified deleted or voided Xero invoice and send them through the ordinary billing flow again, with immutable lineage.

### Rules and state todo

- [x] Restrict all release/rebill commands to owner/admin.
- [x] Make V1 release operate on the complete Invoice Export, not arbitrary individual lines.
- [x] Refresh the invoice from Xero immediately before offering or executing release.
- [x] Permit release only when the remote invoice is verified DELETED or VOIDED.
- [x] Block release when the invoice is DRAFT, SUBMITTED, AUTHORISED, PAID, missing but inconclusive, or unavailable.
- [x] Do not let an administrator bypass remote verification with generic “mark unbilled” editing.
- [x] Require a non-empty human reason and explicit confirmation.
- [x] Keep original Export Batch, Invoice Export, Invoice Export Entries, payload, Xero IDs, totals, and state history immutable.
- [x] Add release metadata or a separate append-only Release Action record:
  - [x] source export;
  - [x] affected entries/allocations;
  - [x] last verified remote status;
  - [x] actor;
  - [x] reason;
  - [x] timestamp;
  - [x] before/after states;
  - [x] later replacement exports.
- [x] Perform release in one MongoDB transaction:
  - [x] recheck current export/entry state;
  - [x] ensure it has not already been released;
  - [x] create release/audit records;
  - [x] mark allocations released but retain them;
  - [x] move every mapped entry from exported to unbilled;
  - [x] clear only its active currentExport pointer;
  - [x] mark the original Invoice Export released.
- [x] Prevent concurrent double release using conditional writes/indexes.
- [x] Ensure releasing does not itself create a replacement invoice.
- [x] When rebilled later, record rebillOf lineage to the release and original export.
- [x] Keep a released entry editable only according to ordinary unbilled rules.

### Admin UX todo

- [x] Add a protected export-detail Admin view with remote state, mapped entries/lines, last reconciliation, and history.
- [x] Add “Refresh status from Xero.”
- [x] Show action-required guidance for deleted/voided/mismatched invoices.
- [x] Show “Release for rebilling” only when eligibility is verified.
- [x] Preview affected entry count, minutes, original amount, customer, and invoice number.
- [x] Explain that all entries on the invoice will return to the unbilled queue.
- [x] Require typed reason and high-impact confirmation.
- [x] After release, provide “Open rebill preview” with released entry IDs preselected.
- [x] Route the replacement through the normal eligibility, preview, reservation, and job flow.
- [x] Display original invoice -> release -> replacement invoice lineage in both directions.

### Verification and acceptance

- [x] Member/biller cannot release through UI, REST, or Local API.
- [x] Active/authorised/paid/inconclusive invoices cannot be released.
- [x] A verified deleted/voided export can be released exactly once.
- [x] All mapped entries update atomically and reappear in the normal billing queue.
- [x] Original snapshots remain unchanged.
- [x] Replacement exports preserve complete rebillOf lineage.
- [x] Concurrent release/rebill tests cannot duplicate state changes or invoices.

## WP-13 — Security, audit, observability, and operational controls

Depends on: Starts at WP-00 and closes after WP-12

Outcome: The application fails closed, protects credentials and billing data, provides actionable diagnostics, and maintains a trustworthy audit history.

### Security todo

- [x] Create and maintain a threat model covering email authentication, invitations, Xero OIDC, account linking, local sessions, Payload Admin, Local API elevation, accounting OAuth, MongoDB, webhooks, jobs, billing commands, and log leakage.
- [x] Cover login CSRF, state/nonce/code replay, callback mix-up, session fixation, invitation replay, provider-subject collision, email-based account takeover, open redirect, and identity/accounting credential mix-up explicitly.
- [x] Maintain a role-by-resource-by-operation access matrix.
- [x] Enforce access in collections, fields, custom endpoints, domain services, and Local API wrappers.
- [x] Treat Admin hidden/read-only configuration as presentation only, never as authorization.
- [x] Disable unused APIs such as GraphQL and unnecessary Payload endpoints.
- [x] Set strict CORS and CSRF origins.
- [x] Set secure, HTTP-only, same-site cookies and suitable session lifetimes.
- [x] Namespace identity/accounting routes, flow records, cookies, callback validation, log fields, and metrics so a request cannot cross trust boundaries.
- [x] Reject identity/accounting client ID or secret reuse during protected accounting setup and runtime loading; keep redirect route handlers fixed and distinct.
- [x] Apply authentication and command rate limits.
- [x] Validate all custom route inputs with shared schemas and reject unknown fields.
- [x] Add request/body size limits.
- [x] Add security headers and a Content Security Policy compatible with Payload Admin.
- [x] Sanitize output rendered in descriptions and Admin diagnostics.
- [x] Prevent mass assignment of roles, rates, billing states, Xero IDs, token fields, audit actors, and export state.
- [x] Encrypt Xero accounting tokens with versioned authenticated encryption and rotation support; identity tokens are never retained.
- [x] Use purpose-separated HKDF-derived keys for encrypted accounting configuration and tokens; keep the identity/accounting OAuth secrets, auth-flow key, webhook key, and CRON_SECRET in separate trust boundaries.
- [x] Add independent audited kill switches for Xero identity sign-in and accounting export/processing.
- [x] Document and test secret rotation.
- [x] Protect cron/job endpoints with machine-only authentication and constant-time checks.
- [ ] Configure Atlas with a least-privilege database user, TLS, alerts, and an explicit network-access decision.
- [x] Review all logs and error reports for ID/access/refresh tokens, authorization codes, state, nonce, PKCE verifier, invitation tokens, provider subjects, session cookies/hashes, descriptions, emails, and full invoice payloads.
- [x] Run dependency, secret, and static-analysis scans in CI.

### Audit todo

- [x] Define a stable audit-event taxonomy.
- [x] Record authentication administration, invitation acceptance method, Xero identity success/failure, link/unlink/collision/recovery, session revocation, role changes, accounting connect/disconnect/reconnect/handover, mapping changes, privileged time corrections, export transitions, retries, reconciliation, release/rebill, and diagnostic overrides.
- [x] Include actor, target, timestamp, correlation ID, reason, and redacted before/after values.
- [x] Record machine actors separately from human actors.
- [x] Make Audit Events append-only to application users, including owners.
- [x] Prevent audit hooks from recursively generating duplicate audit records.
- [x] Establish retention and archive policy.
- [x] Add Admin search/filter by date, actor, event type, customer, entry, export, and Xero invoice.
- [x] Test that failed transactions do not leave false audit events and successful transitions do.

### Observability todo

- [x] Add structured server logging with request, batch, export, job, tenant, and Xero correlation IDs.
- [x] Establish log levels and redact at the logger boundary.
- [ ] Configure error monitoring with environment/release tagging and source maps.
- [x] Add metrics or queries for:
  - [x] login/auth failures;
  - [x] password versus Xero identity login success/failure and latency;
  - [x] OIDC callback replay/claim failures, invite mismatches, and identity-link collisions;
  - [x] active/revoked external sessions and stale Auth Identities;
  - [x] unbilled and blocked entries;
  - [x] queued and processing job age;
  - [x] Xero success/failure/429 counts;
  - [x] token refresh health;
  - [x] reconciliation age;
  - [x] manual-review count;
  - [x] webhook validity/failures;
  - [x] Mongo connection/transaction failures.
- [ ] Add alerts for identity-provider failures, abnormal callback/link failures, accounting connection loss, repeated accounting-token failures, authorizer departure risk, webhook disablement risk, stuck exports, rate-limit exhaustion, and backup failure.
- [x] Add a health endpoint that checks application readiness without leaking environment details.
- [x] Add Admin operational diagnostics with safe retry/refresh links.

### Operational todo

- [x] Document backup, restore, identity-provider outage, compromised identity link, password/owner recovery, identity client-secret rotation, accounting client/token compromise, accounting-authorizer departure/handover, Xero disconnect, token refresh failure, webhook failure, stuck export, duplicate-suspected invoice, and release/rebill runbooks.
- [x] Add owner-controlled, audited kill switches for accepting new exports and wait-for-result execution without hiding or mutating existing export history.
- [x] Prove Xero identity sign-in can be disabled without stopping email/password login or accounting jobs, and accounting export can be disabled without stopping either login method.
- [x] If cron or webhook processing needs to be paused during an incident, retain durable pending work and document safe resumption.
- [ ] Exercise restore and at least one export incident scenario in staging.
- [x] Define data retention, user offboarding, and customer archive behavior.
- [x] On user offboarding, revoke every local session and identity link as policy requires while preserving minimal audit history; do not automatically disconnect the business accounting grant.
- [x] Keep historical billing/audit records when a user/customer/project is deactivated.

### Verification and acceptance

- [x] The full access matrix has automated coverage.
- [x] Secret-scanning and deliberate canary-secret tests find no client/log exposure.
- [x] Automated separation tests prove neither OAuth flow can read or mutate the other flow's records.
- [x] Audit events accurately follow committed state.
- [ ] Alerts fire in controlled staging failure exercises.
- [ ] Restore and incident runbooks are executable by someone other than the implementer.

## WP-14 — Full-system verification and CI quality gates

Depends on: All feature packages

Outcome: Automated and manual evidence shows the system behaves correctly under ordinary, concurrent, and failure conditions.

### Test architecture todo

- [x] Run the current unit suite without network dependencies.
- [x] Run the current integration suite against a real MongoDB replica set, never SQLite or standalone Mongo.
- [x] Create deterministic factories for users, invitations, Auth Identities, external sessions, OAuth flows, customers, projects, entries, exports, Xero responses, and jobs.
- [x] Create a controllable fake OIDC provider distinct from the fake accounting API, including discovery, JWKS/key rotation, valid codes/tokens, malformed claims, errors, and provider outage.
- [x] Create a controllable fake Xero server/client supporting success, validation errors, 401, 429, 5xx, connection reset, delayed response, ambiguous creation, and reconciliation queries.
- [x] Store representative redacted Xero contract fixtures.
- [x] Keep a separate manual/CI-safe Xero Demo Company contract suite.
- [x] Reset and separately namespace unit/integration/end-to-end databases and Next.js build output.

### Mandatory unit coverage

- [x] fail-closed account-email configuration and Resend request/sender mapping;
- [x] timezone parsing and DST resolution;
- [x] range/duration conversion;
- [x] project-rate scaled arithmetic;
- [x] billing eligibility and blockers;
- [x] filter normalization and all-matching semantics;
- [x] grouping by contact/currency;
- [x] one-entry-to-one-line invoice construction;
- [x] Xero precision/rounding boundary;
- [x] payload hashing/idempotency identity;
- [x] export and entry state machines;
- [x] retry classification;
- [x] reconciliation decisions;
- [x] release/rebill eligibility;
- [x] access predicates and redaction;
- [x] issuer/subject identity resolution and normalized invite-email comparison;
- [x] identity-scope allow-list and accounting-scope rejection;
- [x] OIDC state, nonce, issuer, audience, expiry, and return-path validation;
- [x] identity link/unlink/recovery eligibility and session expiry/revocation;
- [x] identity/accounting callback routing and data-boundary guards.

### Mandatory integration/concurrency coverage

- [x] Payload collection and field access for every role and operation.
- [x] Local API overrideAccess wrapper behavior.
- [x] Mongo transaction commit and rollback across collections.
- [x] two billers reserving the same entry;
- [x] two release attempts;
- [x] duplicate submit/double-click;
- [x] duplicate and overlapping cron invocations;
- [x] concurrent OAuth token refresh;
- [x] two concurrent acceptances consuming the same invitation token create exactly one user;
- [x] two callbacks linking the same provider subject;
- [x] duplicate/replayed OIDC state, nonce, and authorization code;
- [x] Xero email change after initial issuer/subject link;
- [x] local Payload session replacement on password change/reset and revocation on suspension;
- [x] local/external session fixation, expiry, logout-all, and identity unlink;
- [x] identity client misconfigured with accounting/offline scopes;
- [x] identity/accounting client reuse rejected at protected accounting setup/runtime, with structurally distinct callbacks;
- [x] identity callback attempts to mutate Xero Connection;
- [x] accounting callback attempts to create a user/session;
- [x] accounting authorizer handover, concurrent callbacks, wrong tenant/scopes, failed validation, and safe rollback;
- [x] crash before Xero send;
- [x] crash after reservation commit but before Payload job attachment;
- [x] Xero creates invoice then response is lost;
- [x] crash after Xero response but before local finalization;
- [x] stale processing-job recovery;
- [x] webhook duplicate/out-of-order delivery;
- [x] immutable snapshots and audit records.

### Mandatory end-to-end coverage

- [x] owner bootstrap and email/password recovery;
- [x] single-use invite acceptance by email/password;
- [ ] invite acceptance by the bound Xero identity flow;
- [ ] explicit Xero link, login, unlink, relink/recovery, reset, and deactivate;
- [ ] uninvited Xero user denial and no automatic merge on matching email;
- [x] email/password login while Xero identity is disabled/unavailable;
- [ ] Xero login/logout/link/unlink with accounting connection values unchanged;
- [ ] accounting disconnect/reconnect with user sessions unchanged;
- [x] member denial from Admin;
- [x] member range and duration entry in selectable timezone;
- [ ] customer import/link/create in Xero;
- [x] project/rate management;
- [x] selected-entry billing preview/export;
- [x] all-filtered uninvoiced preview/export;
- [ ] background completion;
- [ ] wait-for-result completion and fallback;
- [ ] action-required and reconnect;
- [ ] ambiguous result and reconciliation;
- [ ] Xero deleted/voided status refresh;
- [ ] Admin release and successful rebill;
- [x] responsive and keyboard-critical flows.

### CI todo

- [x] Run formatting, lint, TypeScript, Payload type/import-map freshness, unit tests, integration tests, and production build on every pull request.
- [x] Run end-to-end tests on protected branches or suitable preview environments.
- [x] Fail CI when generated Payload types/import map differ from committed output.
- [x] Run dependency audit, license policy, static analysis, and secret scanning.
- [x] Pin CI action/tool versions.
- [x] Upload useful test, coverage, Playwright, and build artifacts without secrets.
- [x] Set meaningful coverage thresholds for domain/access/state-machine code.
- [x] Add a compatibility smoke test for the pinned Payload/Next.js bundle.
- [x] Add a documented dependency upgrade/regression procedure.
- [x] Add a controlled Xero Demo Company pre-release checklist rather than running destructive live tests on every PR.
- [x] Perform a realistic performance test for time-entry list/filter, billing query, large preview, and bounded job batches.

### Verification and acceptance

- [ ] All mandatory test suites pass from a clean checkout.
- [x] No flaky concurrency or timezone test is accepted as “retry until green.”
- [x] A deliberate ambiguous Xero failure produces one invoice and a reconciled local result.
- [x] A security/access regression causes CI to fail.
- [x] A deliberate cross-flow read/write attempt causes CI to fail.
- [ ] The release candidate passes the Xero Demo Company checklist.

Current automated checkpoint (18 July 2026): formatting, ESLint, strict TypeScript, Payload type/import-map freshness, production build, compatibility, secret/license/dependency scans, migrations, 62 index checks, 94 unit tests, 46 real-MongoDB integration tests, 3 performance tests, and 21 Chromium end-to-end tests pass locally. Coverage includes the export processor/maintenance state machine and enforces package thresholds. Password recovery, selected/all-matching billing, project-rate recalculation, responsive/keyboard time entry, minimal readiness responses, Payload Admin branding, and safe cancellation run in-browser; fake-provider integration covers Xero identity, accounting handover, contacts/reference data, export ambiguity/reconciliation, webhooks, and release/rebill. Provider-coupled browser cases, a clean-checkout remote CI run, Resend delivery, and the Demo Company checklist remain gated on hosted registrations/environments.

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
- [ ] Generate production-only PAYLOAD_SECRET, CRON_SECRET, and application secrets.
- [ ] Provision separate production Xero identity and accounting client registrations and secrets.
- [ ] Register and verify the production identity callback, in-app displayed accounting callback, and webhook URLs independently.
- [ ] Confirm protected accounting setup rejects reused identity client IDs or secrets and callback routes remain distinct.
- [ ] Configure the production email sender/domain.
- [ ] Verify production email SPF, DKIM, DMARC, invitation delivery, and password-reset delivery.
- [ ] Configure production error monitoring and alert recipients.
- [ ] Start production with the new-export kill switch enabled while configuration and read-only health checks are verified.
- [ ] Verify environment variables against a checklist without printing their values.
- [ ] Run index/migration status checks.
- [ ] Create exactly one initial owner through the deployment-protected first-user form or controlled seed, then verify email/password recovery before enabling Xero sign-in.
- [ ] Configure Business Settings, Authentication Settings, user timezone defaults, base currency, and Billing Settings.
- [ ] Save the dedicated Xero accounting client ID and secret through `/app/settings/xero`; verify that this requires no environment change or redeploy.
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
- [x] Provide short user guides for:
  - [x] manual range entry;
  - [x] manual hours/minutes entry;
  - [x] timezone preference;
  - [x] accepting an invitation and signing in with Xero;
  - [x] linking/unlinking Xero and password recovery;
  - [x] customer/project management;
  - [x] billing selection and preview;
  - [x] background/wait export;
  - [x] mapping/action-required remediation;
  - [x] release and rebill.
- [x] Provide operator runbooks from WP-13.
- [x] Document deployment, rollback, secret rotation, index migration, backup restore, and dependency upgrade.
- [x] Define the rollback point and ensure rollback does not run incompatible data migrations.
- [ ] Monitor password login, Xero identity OIDC, accounting OAuth/token refresh, Mongo, jobs, webhooks, and exports as separate signals during the launch window.
- [ ] Review early audit records and Xero invoice mappings manually.
- [x] Record V1 known limitations and post-launch backlog.

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
- [Xero developer pricing and connection tiers](https://developer.xero.com/pricing)
- [Xero API limits](https://developer.xero.com/documentation/guides/oauth2/limits)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
- [Vercel Cron security](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
