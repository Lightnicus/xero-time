# Threat model

## Assets

The user's password and sessions, password-reset tokens, accounting refresh tokens, Xero tenant identity, customer/time descriptions, rates, invoice mappings, audit history, and Mongo data are sensitive. Accounting tokens are versioned AES-256-GCM envelopes.

## Principal threats and controls

- Login CSRF, fixation, brute force, and reset enumeration: trusted origins, same-site HTTP-only cookies, session rotation/revocation, generic failures, Payload lockout, and application rate limits.
- Unclaimed empty deployment: whoever reaches Payload Admin first can create the user, so create it while deployment protection is on. Anonymous user creation is denied after that.
- Stolen session or password: the signed-in user can do everything, so a stolen session has full access. Mitigations are short token expiry, session revocation on password change or reset, Payload lockout, and the append-only audit log.
- Accounting OAuth misuse: exact scopes and callback, identity scopes and ID tokens rejected, hashed single-use state, and a pinned tenant that reconnection cannot change.
- Anonymous or Local API access: fail-closed signed-in checks, hidden/private collections for tokens and OAuth state, locked billed time, and protected billing contexts.
- Invoice duplication or lost time: immutable payload hash, one entry/line allocation, Mongo reservation transaction, processing lease, persisted idempotency key, bounded retries, and targeted reconciliation after any possibly-sent request.
- Forged or replayed webhook: raw-body HMAC, constant-time comparison, size/schema limits, durable deduplication, pinned tenant validation, and authoritative reads.
- Mongo or serverless failure: replica-set transactions, bounded connection pool, crash-tolerant dispatcher, queue/cron leases, stale-work recovery, backups, and restore drills.
- Log or error leakage: structured logger boundary redacts credentials, provider subjects, cookies, email, descriptions, and payloads; ordinary APIs deny protected fields.
- Cross-site/script attacks: strict CORS/CSRF origin, output escaping by React, bounded inputs, CSP, frame denial, content-type and body checks.

Review this model whenever a new route, provider scope, retained field, log sink, or state transition is introduced.
