# ADR 0004: Invite-gated authentication

Status: superseded (2026-11-13)

> Superseded on 2026-11-13: the app is now single-user. Its one user is the business owner, so invitations, roles, and Xero identity sign-in were removed. Sign-in is email/password only, and the user is created through Payload Admin's create-first-user screen or `pnpm seed:owner`. The original decision is kept below for history.

Keep email/password as the independent recovery method and offer optional Xero identity sign-in only to a locally invited or explicitly linked account. Email claims never merge accounts, assign roles, or establish registration eligibility.
