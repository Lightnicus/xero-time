# ADR 0008: Custom member UI

Status: accepted

Members and billers use the purpose-built `/app` experience and never Payload Admin. Owners/admins use both. The custom UI exposes only the fields and commands needed for time, billing, identity security, and operations; protected records remain private.

Update 2026-11-13: the app is now single-user with no roles. The one signed-in user uses both `/app` and Payload Admin, and `/app` no longer has identity security screens. Protected records remain private.
