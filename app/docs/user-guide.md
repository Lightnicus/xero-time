# User and operator guide

## Record time

Choose **Add time**, a project, and a complete description. For **Hours and minutes**, select the work date/timezone and whole values. For **Start and finish**, enter both local values; the form shows current UTC offset and calculated duration and rejects ambiguous/nonexistent DST times. Entries are completed work only—V1 has no timer. Change the profile timezone to alter future defaults; existing entries retain their snapshot.

Unbilled entries can be edited, duplicated, or deleted. Reserved/exported entries show why they are locked; privileged users can open the export. Owners/admins must supply an audit reason for corrections and deletion.

## Invitations and login

Open the single-use invitation link and choose email/password or, when enabled, Xero identity. Xero acceptance must use the invitation-bound flow and the same verified normalized email. Xero never assigns the role. Password reset remains available independently. In Profile, link/unlink Xero with recent password confirmation and manage local external sessions; unlinking does not disconnect business accounting.

## Customers, projects, and rates

Owners/admins create local customers/projects in Admin. Customer currency and project currency must match. Use Customer mappings to search/select by Xero ContactID, import a Xero contact, link a local customer, or explicitly create one. Mapping is never inferred from a name. Remapping requires reason/confirmation. After refreshing Xero reference data, use Projects to select an active Xero sales item for every billable project; that item fills Xero's Item column on future invoice lines. A project rate change affects new entries; use Projects to preview/confirm retrospective recalculation of unbilled snapshots only.

## Billing and export

Owners/admins/billers filter eligible and blocked time, select rows/page/all matching/all uninvoiced, and review exact counts/minutes/value/invoice groups. Preview always shows every one-entry/one-line description, quantity, rate, tax, total, dates, contact, currency, and reference. Confirmation rejects changed data.

Background returns after durable dispatch. **Wait for Xero** uses the same job and may continue in background. Export detail shows state/history and supports safe cancel, status refresh, guided Xero recovery, or a linked replacement. For a verified app-created Xero DRAFT, an owner/admin can delete the exact draft and atomically release all mapped time back to unbilled. A draft that does not match the saved export remains locked; the page explains how to resolve it in Xero and check again. Mapping/configuration blockers must be corrected and previewed again.

Only owner/admin can release a remotely verified deleted/voided invoice. The full invoice's entries return to the normal queue and replacement preserves lineage.

## When the Xero connection stops working

Xero can stop accepting the saved connection: someone disconnects the app from Xero's Connected Apps page, the Xero user who connected it loses access, the connection goes unused for 60 days, or the accounting app's client secret is regenerated. When that happens, the connection shows **Action required** and every owner, admin, and biller sees a banner saying Xero needs to be reconnected.

Nothing is lost. Exports that were waiting to go to Xero show **Waiting for Xero**, keep their time reserved, and resume automatically once Xero is reconnected. New exports are blocked with a **Reconnect Xero** setup issue until then.

An owner or admin fixes it from **Settings → Xero accounting**, which explains the cause and the steps:

1. If Xero rejected the client ID or secret, generate a new secret for the accounting app in the Xero developer portal and save it under **Accounting OAuth application**.
2. Sign in to Xero as a user who can create invoices in the pinned organisation.
3. Select **Reconnect Xero**, confirm your password, and choose the same organisation in Xero.
4. If the Xero user who connected it before has left, tick **I am reconnecting as a different Xero user** and give a reason. This is recorded as an authorizer handover.
