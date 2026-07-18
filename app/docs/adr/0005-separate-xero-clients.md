# ADR 0005: Separate Xero clients

Status: accepted

Identity and business accounting use distinct client IDs, secrets, exact callbacks, flow records, cookies, scopes, encryption purposes, and services. Optional identity credentials are environment-managed; accounting credentials are saved through a protected owner/admin action. Accounting setup rejects reuse of a configured identity client ID or secret, and each flow has a fixed, distinct callback route. Neither flow receives authority over the other flow's data.
