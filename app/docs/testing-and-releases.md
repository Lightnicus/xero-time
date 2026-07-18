# Testing, dependency upgrades, and release checklist

Pull requests run formatting/lint/type checks, generated freshness, secret/license checks, unit tests, real replica-set integration tests, index verification, production build, and protected-branch browser tests. Do not accept retries as a remedy for concurrency or timezone failures.

Payload packages must be upgraded together at the same exact version. Upgrade Next/React as one reviewed compatibility change. Read upstream migration/security notes, update one group, regenerate types/import map, run all gates and a Payload Admin/member/Xero fake smoke test, then deploy to staging before production. Dependabot groups these packages accordingly.

`pnpm check:compat` enforces exact Payload/Next/React pins and imports the configured Payload schema. CI uses the distinct fake OIDC and fake accounting servers plus redacted fixtures under `tests/`; neither fake shares tokens or state across trust boundaries. Coverage thresholds are a required regression floor for domain, access, and state-machine code.

`pnpm test:perf` exercises a 20,000-row member summary, 5,000-row billing eligibility pass, the maximum 1,000-line invoice preview, and the hard 100-export dispatcher bound. Its deliberately generous local ceiling catches accidental unbounded or quadratic regressions without treating shared-runner jitter as a product benchmark.

The read-only Demo Company contract is intentionally outside routine CI. Against an isolated environment, set `RUN_XERO_DEMO_CONTRACT=true` and the exact `XERO_DEMO_EXPECTED_TENANT_ID`, then run `pnpm test:xero-contract`. It reads Organisation, Accounts, TaxRates, Currencies, and one Contacts page; it does not create or update Xero data.

## Xero Demo Company pre-release

1. Verify separate identity/accounting client IDs, exact HTTPS callbacks, and identity scope `openid profile email` only.
2. Connect/select the intended Demo Company; verify tenant ID/name, CreateDraftInvoice action, accounts, taxes, currencies, tracking, and contacts.
3. Test customer search/import/link/create and explicit remap warning.
4. Export a one-minute line and representative mixed-minute/rate lines; compare quantity, unit rate, tax, total, full description, ContactID, account, tracking, reference, and one-to-one LineItemID mapping.
5. Exercise background and wait fallback, 400, 401, 429, 5xx, lost response, reconciliation, duplicate cron, and stale-worker recovery through the fake suite plus controlled Demo operations.
6. Delete/void a draft, refresh status, verify no automatic release, then release/rebill through the protected flow.
7. Test webhook intent/signature/duplicate/wrong-tenant handling, email invitation/reset, Xero invite/link/login/unlink, and identity/accounting separation.
8. Complete backup restore, alert, accessibility/keyboard/responsive, and rollback drills; record operator and evidence.
