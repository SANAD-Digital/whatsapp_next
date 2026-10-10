# Test Lab

`WhatsApp › Test Lab` (`/app/wa-test-lab`) is where a manager proves that every part of the
product works — with real messages, to his own numbers, using the site's own templates,
notifications, alerts, commands and documents. It is open to **WhatsApp Manager** and **System
Manager** only, because it sends real messages that count against the plan.

## What is on the page

1. **What the test runs with** — the sending device and its state, the **target numbers** (your
   own; up to five; your own mobile is filled in when your user has one), the **message cap** of
   a run (20, at most 50) and the **seconds between messages** (8, at least 3). The page remembers
   them in the browser.
2. **Connection and setup** — nine read-only checks: platform credentials, subscription and
   balance, webhook endpoint, last event received, sending device, **scheduler**, background
   workers, sending queue, commands. Each one says in plain words what is wrong and what to do.
   "Run the checks" asks the platform now; otherwise the last known state is shown.
3. **Messages** — one card per kind, each with a tick: quick text, image, document (the app's
   sample files, or a file you pick), a **template** over a real record, a **notification** over
   a real record, a **scheduled alert**. "Preview" shows what would be sent. A notification is
   sent to *your* numbers instead of the customer's unless you switch on "Send to the record's
   real recipients instead" — which asks for an explicit confirmation.
4. **Commands** — every active command, run as if the chosen target number had written it
   (nothing stored, nothing sent): the verdict, the block reason, the time it took and the reply
   the customer would get. "Also send the reply to that number for real" sends it.
   **Try it from your phone** lists the words to write and, after "Listen for my message", shows
   your real message arriving, the command it matched and its reply being delivered.
5. **Campaign and receipts** — a mini campaign to the target numbers through the bulk-send path
   (text, image or a template), started now or scheduled a couple of minutes ahead; and the
   receipts card, which reads delivery and read receipts off the messages of the run.
6. **The run** — "Run selected" asks once, then runs the ticked checks one after the other with
   the pause between them. Every row goes waiting → sending → sent → delivered / read, or failed
   with its reason, with a link to the message (the same drawer as the Outbound list) or the
   campaign. Above it: passed · failed · in progress · time to send · time to deliver.
   "Copy report" / "Download" keep the result; "Earlier runs" opens a previous run.

## Things worth knowing

- **Test messages are marked.** Every message of a run carries "Test Send" (`is_test`) in the
  Outbound log, and each run and each check is written in the audit log.
- **A scheduled campaign waits for the scheduler.** Frappe's scheduler looks for due jobs every
  four minutes by default, so a campaign scheduled two minutes ahead starts two to six minutes
  later. If it never starts, the scheduler check above says why.
- **"Sent" without "Delivered".** The page waits three minutes for a receipt and then says so:
  the phone is offline, or the webhook is not reaching the site.
- **Notifications and alerts send from their own device** when one is set on them; everything
  else sends from the device chosen at the top.
- **History** survives `bench clear-cache` and migrations (it is read back from the audit log),
  but an earlier run shows its numbers masked and cannot be continued.
- **Commands answer a number with its own account's records.** A target that is not linked to a
  customer gets "Blocked — Not Linked" for customer commands; that is the product's rule, not a
  fault.

## For developers

The API is described in [api/testlab.md](api/testlab.md). The page is
`whatsapp_next/whatsapp_next/page/wa_test_lab/`, the service `services/testlab.py`, the styles
`public/scss/screens/_test_lab.scss`, the tests `tests/test_api_testlab.py`. The sample files
sent by the image and document checks live in `page/wa_test_lab/samples/` and are stored once as
private Files attached to WhatsApp Settings.
