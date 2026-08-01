# Testing, dependency upgrades, and release checklist

GitHub Actions CI is intentionally disabled. Dependabot is limited to security updates: a `dependabot/**` branch and pull request is a proposed remediation for a GitHub vulnerability alert, not proof that the update is compatible. Vercel preview deployments are disabled for those branches, nothing is auto-merged, and routine dependency upgrades are prepared manually.

For every dependency update, review the advisory plus upstream release and migration notes. Keep `payload` and all `@payloadcms/*` packages pinned to the same exact version, and review Next/React as one compatibility change. From `app/`, using Node 24 and the local environment described in the README, run:

```sh
corepack pnpm install --frozen-lockfile
pnpm db:start
pnpm migrate
pnpm verify:secrets
pnpm verify:licenses
pnpm verify:generated
pnpm check
pnpm check:compat
pnpm test:coverage
pnpm test:perf
pnpm verify:indexes
pnpm audit --prod --audit-level high
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm db:stop
```

The Playwright install is needed only initially and after browser-version changes. Stop the local database when validation is complete, including after an earlier command fails. If generated types or the import map are stale, regenerate and review them, then rerun the checks. Merge only after every command passes and the relevant Payload Admin, member, and Xero fake flows have been smoke-tested; deploy to staging before production. Do not accept retries as a remedy for concurrency or timezone failures.

`pnpm check:compat` enforces exact Payload/Next/React pins and imports the configured Payload schema. Tests use distinct fake OIDC and fake accounting servers plus redacted fixtures under `tests/`; neither fake shares tokens or state across trust boundaries. Coverage thresholds are the regression floor for domain, access, and state-machine code.

`pnpm test:perf` exercises a 20,000-row member summary, 5,000-row billing eligibility pass, the maximum 1,000-line invoice preview, and the hard 100-export dispatcher bound. Its deliberately generous local ceiling catches accidental unbounded or quadratic regressions without treating shared-runner jitter as a product benchmark.

The read-only Demo Company contract is intentionally outside routine CI. Against an isolated environment, set `RUN_XERO_DEMO_CONTRACT=true` and the exact `XERO_DEMO_EXPECTED_TENANT_ID`, then run `pnpm test:xero-contract`. It reads Organisation, Accounts, TaxRates, Currencies, Items, and one Contacts page; it does not create or update Xero data.

## Xero Demo Company pre-release

1. Verify separate identity/accounting client IDs, exact HTTPS callbacks, and identity scope `openid profile email` only.
2. Connect/select the intended Demo Company; verify tenant ID/name, CreateDraftInvoice and DeleteDraftInvoice actions, sales items, accounts, taxes, currencies, tracking, and contacts.
3. Test customer search/import/link/create and explicit remap warning.
4. Export a one-minute line and representative mixed-minute/rate lines; compare quantity, unit rate, tax, total, full description, ContactID, account, tracking, reference, and one-to-one LineItemID mapping.
5. Exercise background and wait fallback, 400, 401, 429, 5xx, lost response, reconciliation, duplicate cron, and stale-worker recovery through the fake suite plus controlled Demo operations.
6. Use the protected delete-draft-and-release command, verify Xero reports DELETED, then preview the released entries for rebilling. Also verify the manual Xero deletion → refresh → release fallback.
7. Test webhook intent/signature/duplicate/wrong-tenant handling, email invitation/reset, Xero invite/link/login/unlink, and identity/accounting separation.
8. Complete backup restore, alert, accessibility/keyboard/responsive, and rollback drills; record operator and evidence.
