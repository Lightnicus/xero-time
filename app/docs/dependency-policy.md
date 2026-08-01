# Dependency policy

Commit the pnpm lockfile and use frozen installs. Keep `payload` and every `@payloadcms/*` package on the same exact release. Review Next/React compatibility together. Routine upgrades are prepared manually; Dependabot may open security-update pull requests, but no automatic merge is permitted.

Every upgrade requires release notes/security review, generated type/import-map refresh, lint/type/unit/integration/E2E/build gates, migration/index review, and staging smoke coverage. Emergency security updates use the same checks with an expedited reviewer. Unsupported, abandoned, copyleft, source-available, or unexpectedly native dependencies require explicit architecture/security approval.

Sharp is intentionally omitted while the application has no upload collections or `next/image` consumers. Before enabling either feature, remove the `next>sharp` exclusion, add a patched compatible Sharp release, restore an image-processing compatibility probe, and run the full release checklist.
