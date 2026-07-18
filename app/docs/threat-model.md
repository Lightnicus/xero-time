# Threat model

## Assets

User credentials, invitation links, local sessions, provider identity links, accounting refresh tokens, Xero tenant identity, customer/time descriptions, rates, invoice mappings, audit history, and Mongo data are sensitive. Identity tokens are ephemeral; accounting tokens are versioned AES-256-GCM envelopes.

## Principal threats and controls

- Login CSRF, fixation, brute force, and reset enumeration: trusted origins, same-site HTTP-only cookies, session rotation/revocation, generic failures, Payload lockout, and application rate limits.
- Invitation replay or email takeover: hashed high-entropy single-use token, expiry, transactional claim, locally assigned role, and invitation-bound Xero callback with verified normalized email.
- OIDC replay/mix-up/collision: separate route/cookie/client, hashed state, encrypted PKCE, nonce and claim validation through `openid-client`, browser/purpose/return-path binding, atomic consumption, issuer/subject identity resolution, and no email-based merge.
- Identity/accounting credential confusion: accounting setup rejects configured identity credentials, with exact scopes/callbacks, distinct modules and encryption purposes, and cross-flow tests.
- Payload Admin or Local API escalation: fail-closed role helpers, field access, hidden/private collections, command authorization, protected billing contexts, and reasoned elevation.
- Invoice duplication or lost time: immutable payload hash, one entry/line allocation, Mongo reservation transaction, processing lease, persisted idempotency key, bounded retries, and targeted reconciliation after any possibly-sent request.
- Forged or replayed webhook: raw-body HMAC, constant-time comparison, size/schema limits, durable deduplication, pinned tenant validation, and authoritative reads.
- Mongo or serverless failure: replica-set transactions, bounded connection pool, crash-tolerant dispatcher, queue/cron leases, stale-work recovery, backups, and restore drills.
- Log or error leakage: structured logger boundary redacts credentials, provider subjects, cookies, email, descriptions, and payloads; ordinary APIs deny protected fields.
- Cross-site/script attacks: strict CORS/CSRF origin, output escaping by React, bounded inputs, CSP, frame denial, content-type and body checks.

Review this model whenever a new route, provider scope, retained field, log sink, or state transition is introduced.
