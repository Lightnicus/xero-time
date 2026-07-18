# ADR 0006: Standard Xero accounting OAuth

Status: accepted

Use Xero's standard Authorization Code flow and rotating offline grant, not Custom Connections. Pin an explicitly selected organisation, validate the granular scopes and access-token claims, and retain safe connection lineage through reconnect or controlled authorizer handover.
