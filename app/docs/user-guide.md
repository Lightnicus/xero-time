# User and operator guide

Project Time has one user: you. Once signed in, you can use every screen, including Payload Admin from **Advanced → Payload Admin**.

## Sign in

Sign in with your email and password. If you forget the password, use **Forgot your password?** on the sign-in page; a reset email is sent only when Resend email delivery is configured. Change your display name, default timezone, or password under **Profile**. Changing the password signs out your other browser sessions.

## Record time

Choose **Add time**, a project, and a complete description. For **Hours and minutes**, select the work date/timezone and whole values. For **Start and finish**, enter both local values; the form shows current UTC offset and calculated duration and rejects ambiguous/nonexistent DST times. Entries are completed work only—V1 has no timer. Change the profile timezone to alter future defaults; existing entries retain their snapshot.

Unbilled entries can be edited, duplicated, or deleted. Reserved or exported entries are locked and show why; you can open the export from the entry. To change locked time, release it from its export first.

## Customers, projects, and rates

Create local customers and projects in Payload Admin. Customer currency and project currency must match. Use **Customer billing** to search for a Xero contact, import it, link a local customer, or explicitly create one. Mapping is never inferred from a name. Changing a mapping asks you to confirm that historical invoices keep their original contact. After refreshing Xero reference data, use **Project billing** to select an active Xero sales item for every billable project; that item fills Xero's Item column on future invoice lines. A project rate change affects new entries; use **Project billing** to preview and confirm a recalculation of unbilled snapshots only.

## Billing and export

On the **Billing queue**, filter eligible and blocked time, select rows, a page, all matching, or all uninvoiced time, and review exact counts, minutes, value, and invoice groups. Preview always shows every one-entry/one-line description, quantity, rate, tax, total, dates, contact, currency, and reference. Confirmation rejects changed data.

Background returns after durable dispatch. **Wait for Xero** uses the same job and may continue in background. Export detail shows state/history and supports safe cancel, status refresh, guided Xero recovery, or a linked replacement. For a verified app-created Xero DRAFT, you can delete the exact draft and atomically release all mapped time back to unbilled. A draft that does not match the saved export remains locked; the page explains how to resolve it in Xero and check again. Mapping/configuration blockers must be corrected and previewed again.

You can release an invoice only after Xero confirms it is deleted or voided. The full invoice's entries return to the normal queue and replacement preserves lineage.

## When the Xero connection stops working

Xero can stop accepting the saved connection: someone disconnects the app from Xero's Connected Apps page, the Xero user who connected it loses access, the connection goes unused for 60 days, or the accounting app's client secret is regenerated. When that happens, the connection shows **Action required** and every page shows a banner saying Xero needs to be reconnected.

Nothing is lost. Exports that were waiting to go to Xero show **Waiting for Xero to be reconnected**, keep their time reserved, and resume automatically once Xero is reconnected. New exports are blocked with a **Reconnect Xero** setup issue until then.

Fix it from **Settings → Xero accounting**, which explains the cause and the steps:

1. If Xero rejected the client ID or secret, generate a new secret for the accounting app in the Xero developer portal and save it under **Accounting OAuth application**.
2. Sign in to Xero as a user who can create invoices in the pinned organisation. It does not have to be the Xero user who connected it before.
3. Select **Reconnect Xero** and choose the same organisation in Xero.
