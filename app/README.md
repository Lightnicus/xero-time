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

In an empty environment, including production, the first visit to Payload Admin can create the initial user. That one-time bootstrap is forced to an active `owner` and protected by an atomic MongoDB lock; every later anonymous user-creation attempt is denied. Only active `owner` and `admin` users can enter Payload Admin. `member` and `biller` users are reserved for the custom application screens. Passwords require at least 8 characters; repeated failed logins trigger Payload's timed lockout. Authentication cookies are marked secure in production.

Anyone who can reach a completely empty deployment can attempt to become its first owner, so claim the production owner while Vercel Deployment Protection is enabled or before making the deployment public. As an optional non-interactive alternative, set the temporary `SEED_OWNER_*` values described in `.env.example`, run `pnpm seed:owner` as a controlled one-off task, then remove those values. The seed refuses to create an owner once another user exists, is safe to rerun for the same active owner, and uses the same atomic bootstrap lock.

The Payload model includes users, invite-gated Xero identities and hashed local external sessions, settings, customers/projects/time, the encrypted single-tenant Xero accounting grant, cached references, immutable export snapshots/attempts, webhook receipts, release lineage, and append-only audit events.

The custom application provides both login methods, account/session security, manual range or duration entry, exact filtered totals, Xero contact mapping, project-rate recalculation, a complete eligible/blocked billing queue and preview, durable background or wait export, reconciliation/status tools, and protected release/rebill. Owners/admins can also use Payload Admin; members and billers cannot.

## Trying the member application

1. Sign in to `/admin` as an owner or admin.
2. Create an active customer and an active project with matching currency and a project rate.
3. Open `/app/settings/users`, issue a `member` invitation, and open the one-time development setup link shown after submission.
4. Choose a password of at least 8 characters. Successful acceptance signs in the new member automatically.
5. Add time from `/app/time/new` using either hours/minutes or start/finish.
6. Use the filters and period controls on `/app`, or open an unbilled entry to edit, duplicate, or delete it.
7. Change the member's display name, default timezone, or password from `/app/profile`.

See [architecture](docs/architecture.md), [access matrix](docs/access-matrix.md), [user guide](docs/user-guide.md), and [operator runbooks](docs/runbooks.md) for the implemented behavior.

## Account email delivery

The application uses Payload's official Resend adapter. `ACCOUNT_EMAIL_DELIVERY_MODE` still defaults to `manual`, so a newly cloned environment cannot send account emails accidentally. In manual mode the server never invokes Payload's non-delivering console email fallback for invitation or password-reset operations:

- an owner/admin sees each newly issued invitation URL once on `/app/settings/users` and can deliver it through a trusted channel;
- password-reset requests always return the same public response, but no reset token is generated or delivered;
- direct forgot-password operations are denied, so they cannot create an unusable reset token or report false delivery.

To enable delivery through Resend:

1. Add and verify the sending domain in Resend. Use an address on that domain for `RESEND_FROM_ADDRESS`.
2. Create a sending API key and set `RESEND_API_KEY` as a server-only Vercel environment variable.
3. Set `RESEND_FROM_NAME` and `RESEND_FROM_ADDRESS` in the same Vercel environment.
4. Change `ACCOUNT_EMAIL_DELIVERY_MODE` from `manual` to `resend` and redeploy.
5. Issue a staging invitation and password reset, then verify receipt, link host, expiry, and single-use behavior before enabling production traffic.

The application fails at startup if Resend mode is missing any required value or the sender is malformed. Invitation and password-reset delivery also verify that Payload initialized the `resend-rest` adapter before generating or marking mail as sent. Resend HTTP failures leave invitations available for a safe token-rotating retry, while password-reset requests retain their generic public response. Email verification, rate limiting, delivery-event webhooks, and SPF/DKIM/DMARC operational checks remain outstanding production work.

## Local MongoDB

The database scripts manage an isolated single-member replica set:

```sh
pnpm db:start
pnpm db:status
pnpm db:stop
```

It listens only on `localhost:27018`, uses replica set `xero_time_rs0`, and stores ignored runtime data under `.local/mongodb/`. It does not start, stop, or reconfigure a Homebrew MongoDB service on port 27017.

The replica set is required for Payload operations that use MongoDB transactions. It is a development topology only, not a production database configuration.

## Xero development applications

The application uses separate Auth Code registrations for user identity and business accounting. Never reuse a client ID between these trust boundaries:

| Purpose                        | Configuration                     | Local redirect URI                                                | Runtime scopes                                                                    |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| User identity login            | Server environment (optional)     | `http://localhost:3000/api/auth/xero/identity/callback`           | `openid profile email`                                                            |
| Business accounting connection | Protected owner/admin application | `http://localhost:3000/api/integrations/xero/accounting/callback` | `offline_access accounting.invoices accounting.contacts accounting.settings.read` |

Optional Xero identity credentials belong in the ignored `.env`. Accounting credentials are entered through `/app/settings/xero`; never put real provider credentials in `.env.example` or expose them through `NEXT_PUBLIC_` variables.

Both integrations are implemented but remain independently disabled until their dedicated client registrations are configured. Email/password always remains available.

### Configure the accounting connection locally

1. Sign in as an active owner or admin and open `/app/settings/xero`.
2. Create a standard OAuth 2.0 Web app in the Xero developer portal specifically for the business accounting connection.
3. Copy the exact callback URI shown by the application into the Xero app registration.
4. Paste the accounting client ID and client secret into the protected form, confirm the current local account password, and save.
5. Connect and authorize the intended Xero organisation. If Xero returns more than one organisation, the application requires an explicit selection and permanently pins that tenant for reconnection safety.

Saving does not require an environment change, restart, or redeploy. The application derives the callback from `NEXT_PUBLIC_SERVER_URL`, stores only an authenticated-encryption envelope for the client secret, and derives purpose-separated configuration and token keys from the existing `PAYLOAD_SECRET`. The client secret is write-only in the UI.

The accounting flow requests only `offline_access accounting.invoices accounting.contacts accounting.settings.read`. It rejects identity scopes and ID tokens, stores only authenticated-encryption envelopes for access/refresh tokens, and keeps its private connection and OAuth-state collections unavailable through Payload REST and Admin. Configure, connect, and disconnect require local owner/admin authorization and the current local password. A manual health check refreshes an expiring access token and verifies the pinned Xero connection.

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
- While deployment protection is enabled, create the first owner through Payload Admin or the optional controlled seed before sending public traffic.
- Payload media uploads are intentionally disabled until persistent object storage is configured; Vercel's application filesystem is not durable storage.

Deployment isolation, migration, rollback, backup, secret-rotation, and Xero Demo Company procedures are in [deployment](docs/deployment.md), [security operations](docs/security-operations.md), and [testing and releases](docs/testing-and-releases.md).
