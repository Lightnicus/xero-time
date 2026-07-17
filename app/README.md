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

On this original development checkout, an ignored `.env` with generated local secrets has already been created.

Open:

- Application: http://localhost:3000
- Payload Admin: http://localhost:3000/admin

The first visit to Payload Admin creates the initial administrative user. This bootstrap account is temporary scaffolding; application roles and the exclusion of time-entry users from Payload Admin are implemented in the authentication work package.

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

The application will use two separate Auth Code registrations:

| Purpose                        | Local redirect URI                                                | Runtime scopes                                                                    |
| ------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| User identity login            | `http://localhost:3000/api/auth/xero/identity/callback`           | `openid profile email`                                                            |
| Business accounting connection | `http://localhost:3000/api/integrations/xero/accounting/callback` | `offline_access accounting.invoices accounting.contacts accounting.settings.read` |

Add the corresponding client IDs and secrets to the ignored `.env`. Never put real credentials in `.env.example` or expose them through `NEXT_PUBLIC_` variables.

The routes themselves are intentionally not present in this setup scaffold; they are implemented in their respective authentication and Xero work packages.

## Verification

```sh
pnpm lint
pnpm test:int
pnpm build
```

End-to-end tests additionally require Playwright's browser binaries and a running development application.

## Vercel

When creating the Vercel project:

- Set **Root Directory** to `app`.
- Use Node.js 24.
- Copy required values from `.env.example` into the appropriate Vercel environment; use distinct secrets and databases for staging and production.
- Never expose the production MongoDB URI or Xero secrets to unrestricted preview deployments.
