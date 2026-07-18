# ADR 0003: Single-business boundary

Status: accepted

V1 represents one business and one pinned Xero tenant. There is no tenant discriminator in ordinary domain records. A tenant migration is a separate controlled project; reconnect and authorizer handover may not silently change the pinned tenant.
