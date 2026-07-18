# Dependency policy

Commit the pnpm lockfile and use frozen installs. Keep `payload` and every `@payloadcms/*` package on the same exact release. Review Next/React compatibility together. Dependabot opens grouped weekly updates; no automatic merge is permitted.

Every upgrade requires release notes/security review, generated type/import-map refresh, lint/type/unit/integration/E2E/build gates, migration/index review, and staging smoke coverage. Emergency security updates use the same checks with an expedited reviewer. Unsupported, abandoned, copyleft, source-available, or unexpectedly native dependencies require explicit architecture/security approval.
