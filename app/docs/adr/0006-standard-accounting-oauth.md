# ADR 0006: Standard Xero accounting OAuth

Status: accepted

Use Xero's standard Authorization Code flow and rotating offline grant, not Custom Connections. Pin an explicitly selected organisation, validate the granular scopes and access-token claims, and retain safe connection lineage through reconnect.

Update 2026-11-13: authorizer handover was removed. Any Xero user who can create invoices in the pinned organisation can reconnect, and exports parked while Xero needed reconnecting resume automatically.
