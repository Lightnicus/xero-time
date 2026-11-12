# ADR 0005: Separate Xero clients

Status: superseded (2026-11-13)

> Superseded on 2026-11-13: the app is now single-user, and Xero identity sign-in was removed with invitations and roles. Only the Xero accounting client remains, so there is no second client to keep separate. The accounting flow still rejects identity scopes and ID tokens. The original decision is kept below for history.

Identity and business accounting use distinct client IDs, secrets, exact callbacks, flow records, cookies, scopes, encryption purposes, and services. Optional identity credentials are environment-managed; accounting credentials are saved through a protected owner/admin action. Accounting setup rejects reuse of a configured identity client ID or secret, and each flow has a fixed, distinct callback route. Neither flow receives authority over the other flow's data.
