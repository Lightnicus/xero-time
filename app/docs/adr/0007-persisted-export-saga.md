# ADR 0007: Persisted export saga

Status: accepted

Confirmation stores selection semantics, immutable invoice/line snapshots, time reservations, request hash, attempt, idempotency identity, and dispatch intent in MongoDB before any Xero call. Definite failures, ambiguous sends, reconciliation, remote status, release, and rebill are explicit states rather than inferred from job completion.
