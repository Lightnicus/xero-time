# Migration conventions

Create migrations with `pnpm migrate:create <name>`, commit them in order, and make each safe to retry or detect prior completion. Never mix destructive cleanup with a feature deployment. Backfill immutable billing/identity fields in bounded batches and preserve snapshots/audit history.

Run `pnpm migrate:status`, take/verify a backup, run `pnpm migrate`, then `pnpm verify:indexes` in a controlled deployment step before traffic or workers are enabled. Mongo field additions may need no DDL, but partial/TTL/unique indexes and semantic backfills always require an explicit migration or idempotent index routine. Down migrations must not be used in production incident rollback unless data compatibility and recovery have been proven separately.

MongoDB rejects `createIndexes` under the application's snapshot transaction options. Index migrations therefore create each named index idempotently outside the Payload migration session; only the migration record is transactional. A failed run may leave a valid prefix of indexes and is safe to rerun after remediation. Never rename or weaken an existing correctness index in the same deployment as application code.
