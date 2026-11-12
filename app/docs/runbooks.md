# Operator runbooks

## Backup and restore

Confirm Atlas backup completion daily. For a drill, restore to a new non-production cluster, use isolated secrets/hostname, run index verification, compare record counts and a sample export lineage, then destroy the drill environment. Never point a preview at production during validation.

## Password recovery

Use password reset through the verified sender. If the mailbox is inaccessible, keep the service protected, restore a tested backup into an isolated environment if investigation is needed, and set a new password through a separately reviewed database procedure. Do not reopen Payload Admin's create-first-user screen by deleting the user.

## Accounting secret, token, disconnect, or lost Xero access

Settings → Xero accounting shows the cause and the steps. Exports that hit the failure are parked as `retry-wait`/`reconciling` with `lastErrorCode: xero-reconnect-required`, and their time stays reserved. A successful reconnect re-queues them immediately; they also recheck every 6 hours. The first failure of an outage emails the user once (`reconnectAlertSentAt` on the connection records it; reconnecting clears it).

- Token failure or lost access: reconnect to the pinned tenant as any Xero user who can create invoices there. It does not have to be the Xero user who connected it before.
- Rejected client secret: generate a new secret in the Xero developer portal, save it under **Accounting OAuth application**, then reconnect.
- Compromise: pause new exports and processing, and revoke the connection in Xero. Disconnect in the app once every export is finished or cancelled; disconnect refuses while any export is still in progress. Then rotate the client secret (and `PAYLOAD_SECRET` only with a re-encryption migration), reconnect, and reconcile unresolved exports.

## Webhook failure

Keep the webhook endpoint deployed and key consistent with Xero. Inspect safe receipt counts, validate provider delivery, rotate a compromised key, then resume processing; receipts remain durable. Run status refresh for affected invoices. Never release entries solely from an event body.

## Stuck or duplicate-suspected export

Each cron run fails any Xero job still marked processing after 10 minutes (a worker that died, for example on a function timeout), so one stalled job cannot block the shared queue; the export's lease recovery then retries or reconciles it. An export that fails 8 automatic retries in a row goes to `manual-review` with `retry-limit-reached` and keeps its time reserved; fix the cause and use **Request recovery**. Status refresh only changes succeeded exports, ones it flagged itself, and reviews whose invoice Xero reports deleted or voided, and it never overwrites a newer change. Run the queue dispatcher and inspect the export/attempt timeline. A pre-send preparing/queued export may be cancelled or retried according to state. If a request may have been sent, keep entries reserved, run targeted reconciliation by InvoiceID/reference, and compare all material lines. Never issue a new POST merely because a request timed out. Accept a verified existing invoice or authorize a linked replacement only through the manual-resolution commands.

## Release and rebill

Refresh from Xero. Release the complete export only if the authoritative status is `DELETED` or `VOIDED`; the command checks Xero again before changing any time. Confirm all entries return to unbilled, then open the normal preselected rebill preview. Never edit original snapshots or release a draft/authorised/paid/inconclusive invoice.

## Safe pause and resume

`acceptingNewExports` stops new reservations; `processingEnabled` stops workers while preserving pending work (the daily Xero connection check still runs, so the refresh token never lapses during a pause); `waitForResultEnabled` disables synchronous waiting. After remediation, verify connection/reference health, run the dispatcher/queue once, monitor old work, then reopen new exports.
