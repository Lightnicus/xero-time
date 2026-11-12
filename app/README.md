# Xero Time application

This directory is the deployable Next.js and Payload application.

## Prerequisites

- Node.js 20.9 or newer; Node.js 24 LTS is recommended for hosted environments
- pnpm 10.28.1 (the version is recorded in `package.json`)
- MongoDB 8, including the `mongod` and `mongosh` commands

With nvm and Corepack installed, select an appropriate Node release and enable pnpm:

```sh
nvm install 24
nvm use 24
corepack enable pnpm
git config core.hooksPath .githooks
```

## First run

From this directory:

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:start
pnpm dev
```

Replace the placeholder `PAYLOAD_SECRET` in a newly copied `.env` with the result of:

```sh
openssl rand -hex 32
```

`MONGODB_URI` is the application database connection string; its name matches the variable supplied by Vercel MongoDB integrations.

On this original development checkout, an ignored `.env` with generated local secrets has already been created.

Open:

- Application: http://localhost:3000
- Payload Admin: http://localhost:3000/admin

Project Time is built for one person: the business owner who records time and sends invoices to Xero. There are no roles. Anyone signed in can use every screen, including Payload Admin. Anonymous requests are denied.

In an empty environment, including production, the first visit to Payload Admin can create the user. After that, anonymous user creation is denied. Passwords need at least 8 characters, repeated failed logins trigger Payload's timed lockout, and authentication cookies are secure in production.

Anyone who can reach a completely empty deployment could create that first user, so create it while Vercel Deployment Protection is on or before the deployment is public. As a non-interactive alternative, set the temporary `SEED_OWNER_*` values described in `.env.example`, run `pnpm seed:owner` once, then remove those values. The seed creates the user only when no user exists, and does nothing if that email already exists.

The Payload model includes the user, settings, customers, projects and time, the encrypted Xero accounting grant, cached Xero references, immutable export snapshots and attempts, webhook receipts, release lineage, and append-only audit events.

The custom application provides email/password sign-in, profile and password settings, time entry by range or duration, filtered totals, Xero contact mapping, project-rate recalculation, the billing queue and preview, background or wait export, reconciliation and status tools, and release and rebill.

## Trying the application

1. Sign in to `/admin`, or create the first user there.
2. Create an active customer and an active project with matching currency and a project rate.
3. Add time from `/app/time/new` using either hours/minutes or start/finish.
4. Use the filters and period controls on `/app`, or open an unbilled entry to edit, duplicate, or delete it.
5. Change your display name, default timezone, or password from `/app/profile`.

See [architecture](docs/architecture.md), [user guide](docs/user-guide.md), and [operator runbooks](docs/runbooks.md) for the implemented behavior.

## Account email delivery

The only account email is the password reset. The application uses Payload's official Resend adapter. `ACCOUNT_EMAIL_DELIVERY_MODE` defaults to `manual`, so a newly cloned environment cannot send email by accident. In manual mode:

- password-reset requests always return the same public response, but no reset token is generated or delivered;
- direct forgot-password operations are denied, so they cannot create an unusable reset token or report false delivery.

To enable delivery through Resend:

1. Add and verify the sending domain in Resend. Use an address on that domain for `RESEND_FROM_ADDRESS`.
2. Create a sending API key and set `RESEND_API_KEY` as a server-only Vercel environment variable.
3. Set `RESEND_FROM_NAME` and `RESEND_FROM_ADDRESS` in the same Vercel environment.
4. Change `ACCOUNT_EMAIL_DELIVERY_MODE` from `manual` to `resend` and redeploy.
5. Request a staging password reset, then verify receipt, link host, expiry, and single-use behavior before enabling production traffic.

The application fails at startup if Resend mode is missing any required value or the sender is malformed. Password-reset delivery also checks that Payload initialized the `resend-rest` adapter before generating a token. Resend HTTP failures keep the generic public response. Delivery-event webhooks and SPF/DKIM/DMARC checks remain outstanding production work.

## Local MongoDB

The database scripts manage an isolated single-member replica set:

```sh
pnpm db:start
pnpm db:status
pnpm db:stop
```

It listens only on `localhost:27018`, uses replica set `xero_time_rs0`, and stores ignored runtime data under `.local/mongodb/`. It does not start, stop, or reconfigure a Homebrew MongoDB service on port 27017.

The replica set is required for Payload operations that use MongoDB transactions. It is a development topology only, not a production database configuration.

## Xero development application

The application uses one Xero Auth Code registration, for the business accounting connection:

| Configuration                | Local redirect URI                                                | Runtime scopes                                                                    |
| ---------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Entered in the signed-in app | `http://localhost:3000/api/integrations/xero/accounting/callback` | `offline_access accounting.invoices accounting.contacts accounting.settings.read` |

Accounting credentials are entered through `/app/settings/xero`. Never put real provider credentials in `.env.example` or expose them through `NEXT_PUBLIC_` variables. Sign-in is always email/password.

### Configure the accounting connection locally

1. Sign in and open `/app/settings/xero`.
2. Create a standard OAuth 2.0 Web app in the Xero developer portal for the business accounting connection.
3. Copy the exact callback URI shown by the application into the Xero app registration.
4. Paste the client ID and client secret into the form and save.
5. Connect and authorize the intended Xero organisation. If Xero returns more than one organisation, the application asks you to choose one and then pins that organisation for every later reconnection.

Saving does not require an environment change, restart, or redeploy. The application derives the callback from `NEXT_PUBLIC_SERVER_URL`, stores only an authenticated-encryption envelope for the client secret, and derives purpose-separated configuration and token keys from the existing `PAYLOAD_SECRET`. The client secret is write-only in the UI.

The accounting flow requests only `offline_access accounting.invoices accounting.contacts accounting.settings.read`. It rejects identity scopes and ID tokens, stores only authenticated-encryption envelopes for access/refresh tokens, and keeps its private connection and OAuth-state collections unavailable through Payload REST and Admin. Configure, connect, and disconnect need a signed-in session. A manual health check refreshes an expiring access token and verifies the pinned Xero connection.

If Xero stops accepting the connection, Settings → Xero accounting explains the cause and the steps, and every page shows a reconnect banner. Any Xero user who can create invoices in the pinned organisation can reconnect. Exports parked while Xero was unavailable resume automatically.

Set `NEXT_PUBLIC_SERVER_URL` to the stable deployment origin during the normal application deployment, then use the callback shown in the application for that environment's Xero registration. Treat `PAYLOAD_SECRET` as a persistent root key: changing it without a migration makes the saved accounting client secret and tokens unreadable. For a planned root-secret change, disconnect first and reconfigure/reconnect after rotation.

Live authorization still needs to be exercised against a Xero Demo Company once development credentials are available. Automated tests never send credentials or requests to Xero.

## Verification

```sh
pnpm test:unit
pnpm test:int
pnpm check
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm verify:indexes
pnpm verify:generated
pnpm verify:secrets
```

Start the local replica set before integration tests. The test configuration refuses to clean anything except the isolated `xero_time_test` database on local port 27018.

End-to-end tests additionally require Playwright's browser binaries. Playwright starts its own application on port 3101, uses the isolated `xero_time_e2e` database, and writes Next.js output to `.next-e2e` so it does not collide with the normal development server.

## Vercel

When creating the Vercel project:

- Set **Root Directory** to `app`.
- Use the **Next.js** Framework Preset and leave the Output Directory override disabled; do not set it to `public` or `.next`.
- Use Node.js 24.
- Confirm the MongoDB integration supplies `MONGODB_URI`, then copy the other required values from `.env.example` into the appropriate Vercel environment; use distinct secrets and databases for staging and production.
- Never expose the production MongoDB URI or Xero secrets to unrestricted preview deployments.
- Automatic Vercel deployments are disabled for `dependabot/**` branches; validate dependency pull requests locally before merging them.
- While deployment protection is enabled, create the user through Payload Admin or `pnpm seed:owner` before sending public traffic.
- Payload media uploads are intentionally disabled until persistent object storage is configured; Vercel's application filesystem is not durable storage.

Deployment isolation, migration, rollback, backup, secret-rotation, and Xero Demo Company procedures are in [deployment](docs/deployment.md), [security operations](docs/security-operations.md), and [testing and releases](docs/testing-and-releases.md).
