# ADR 0003: Single-business boundary

Status: accepted

V1 represents one business and one pinned Xero tenant. There is no tenant discriminator in ordinary domain records. A tenant migration is a separate controlled project; reconnecting may not silently change the pinned tenant.

Update 2026-11-13: the app is also single-user; see ADR 0004.
