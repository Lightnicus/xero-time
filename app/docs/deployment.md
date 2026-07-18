# Deployment and environment isolation

Set Vercel Root Directory to `app`, Framework Preset to Next.js, the Output Directory override to disabled, Node.js to 24, and a region close to the chosen Atlas region. Do not set a static `public` or `.next` output directory; Vercel must use its Next.js runtime defaults. Use separate Vercel projects/environments, Atlas databases (prefer separate projects), Resend keys/senders, hostnames, and two Xero app registrations per hosted environment. Never expose production database or provider secrets to preview deployments; preview must default to an isolated database or no protected integration credentials.

Production requires Vercel Pro for the one-minute cron and Atlas Flex or better for backup support. Choose either restricted static egress where available, or a documented broad Atlas network allow-list combined with a least-privilege application database user, TLS, short credential rotation, and alerts. Do not retain a Marketplace administrator credential.

Xero pricing was last checked on 18 July 2026. Xero's published Starter developer tier is free for up to five connections; this single-business application uses one accounting-tenant connection and therefore fits that allowance. Xero determines whether the bespoke single-client exemption applies. Confirm the app's assigned tier in the Developer Portal and recheck [Xero developer pricing](https://developer.xero.com/pricing) and [OAuth/API limits](https://developer.xero.com/documentation/guides/oauth2/limits) immediately before each hosted launch.

## Controlled deployment

1. Verify exact dependency/Node/pnpm versions and run `pnpm install --frozen-lockfile`.
2. Configure the baseline and optional environment values from `.env.example` without printing them. Accounting OAuth credentials are deliberately absent and are configured later through the protected application.
3. Run `pnpm migrate:status`, `pnpm migrate`, `pnpm verify:indexes`, generated checks, tests, and build against the target environment in a controlled job.
4. While deployment protection is enabled, create the first owner through Payload Admin or use `pnpm seed:owner`; verify email/password recovery and remove any `SEED_OWNER_*` values before public exposure.
5. Keep `acceptingNewExports`, `processingEnabled`, wait mode, and Xero identity login disabled initially.
6. Open `/app/settings/xero`, copy its exact callback into the dedicated Xero accounting app, save the client ID and write-only secret, connect the explicitly verified tenant, refresh references/contacts, and run the Demo Company checklist in `testing-and-releases.md`. This step requires no environment change or redeploy.
7. Enable processing and one controlled draft; compare every line before opening exports. Enable identity sign-in separately after its checks.

Rollback application code only to a version compatible with already-applied migrations. Never run a destructive down migration during incident response. Pause new exports/processing, retain durable work, deploy the last compatible release, and reconcile any possibly-sent Xero attempt before resuming.
