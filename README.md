# solana-subscriptions-billing

Self-hostable billing engine for the [Solana Subscriptions program](https://github.com/solana-foundation/subscriptions)
(`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`).

The program enforces *what* may be pulled from a subscriber; it does not pull anything on its own.
As its docs put it, it "does not replace invoicing, account management, notifications, or entitlement
enforcement." This service is that missing off-chain layer:

| Component      | What it does                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------ |
| **Indexer**    | Snapshots plans and subscriptions from chain into Postgres.                                      |
| **Worker**     | Charges each due period via `transferSubscription` as the plan owner or a whitelisted puller.    |
| **Retries**    | Preflights balance/delegate off-chain, classifies failures, retries on a configurable schedule. |
| **API**        | Subscription state, charge history, and a `GET /entitlements/:wallet` access check.            |
| **Webhooks**   | Signed [Standard Webhooks](https://www.standardwebhooks.com) for payments and subscription changes. |

No changes to the audited program; it builds on `@solana/subscriptions`.

## Quick start

```bash
pnpm install
cp .env.example .env            # edit RPC_URL, KEYPAIR_PATH, ...
pnpm billing migrate
pnpm billing sync               # one snapshot
pnpm billing charge             # one charge cycle (needs KEYPAIR_PATH)
pnpm dev                        # sync + charge + webhook loops, API on :8787
```

With no `DATABASE_URL`, data goes to an embedded Postgres (PGlite) in `./.data`. For production use
real Postgres: `docker compose up -d` and `DATABASE_URL=postgres://billing:billing@localhost:5432/billing`.

Read-only mode (indexer + API, no charging): leave `KEYPAIR_PATH` unset and set `PLAN_SCOPE=all`
or a list of plan addresses.

Start with `DRY_RUN=true` to see what the worker would charge without sending anything.

## How charging works

Billing rules are mirrored from the program (`transfer_validation.rs`) in
[`src/core/billing.ts`](src/core/billing.ts), so the worker only submits charges the program will accept:

- `subscribe` pulls nothing, so a new subscription is due immediately.
- Each period is charged once, for the unpaid remainder of that period.
- Cancellation sets `expiresAtTs` to the end of the current period; charging stops at that instant.
  A plan's `endTs` stops charging after that instant.

Each attempt is recorded before its transaction is sent, with the signature, so a crash mid-send is
reconciled on the next cycle from the signature status instead of being re-sent blindly. A unique index
allows at most one pending-or-succeeded attempt per subscription period, so concurrent workers or restarts
cannot double-charge (and the program caps each period on-chain regardless).

Before sending, the worker checks the subscriber's token account off-chain and records a failed attempt
without paying a fee if the account is missing, the Subscription Authority is no longer its delegate, or
the balance is short.

| Failure reason           | Retried?                     |
| ------------------------ | ---------------------------- |
| `insufficient_funds`     | yes, per `RETRY_SCHEDULE_SECS` |
| `delegate_revoked`       | yes (user may re-approve)    |
| `source_account_missing` | yes                          |
| `transient` (RPC, timeout) | yes                        |
| `program_error`          | yes                          |
| `subscription_cancelled` | no                           |
| `plan_ended`             | no                           |

## Entitlements

`GET /entitlements/:wallet?plan=<plan>` answers "should this wallet have access right now?":

| Status        | Entitled | Meaning                                                            |
| ------------- | -------- | ------------------------------------------------------------------ |
| `active`      | yes      | current period paid                                                |
| `cancelling`  | yes      | paid and cancelled; access until `expiresAtTs`                    |
| `grace`       | yes      | payment due, within `GRACE_PERIOD_SECS` of the first unpaid period |
| `past_due`    | no       | grace over                                                          |
| `cancelled`, `plan_ended`, `not_started` | no |                                              |

Other endpoints: `GET /plans`, `GET /plans/:address`, `GET /subscriptions/:address`,
`GET /charges?status=failed`, `GET /events` (see [Webhooks](#webhooks)). Set `API_KEY` to require `Authorization: Bearer <key>`; otherwise
keep the API bound to localhost.

## Webhooks

Every subscription and payment change is recorded as an event in the same SQL statement as the
change itself, so an event is never lost or emitted for a change that didn't commit. Set
`WEBHOOK_URL` to have them POSTed to you:

```bash
pnpm billing webhook-secret     # prints whsec_...; put it in WEBHOOK_SECRET
```

| Event                    | When                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `subscription.created`   | a subscription is first seen (or reappears after being closed)           |
| `subscription.cancelled` | the subscriber cancelled; `data.expiresAtTs` is when access ends         |
| `subscription.closed`    | the subscription account no longer exists on-chain                       |
| `payment.succeeded`      | this worker's charge landed; `data.signature` is the transaction         |
| `payment.failed`         | a charge attempt failed; `data.reason`, `data.nextRetryAt`, `data.final` |

```json
{
  "id": "evt_5f0c...",
  "type": "payment.succeeded",
  "timestamp": "2026-10-31T12:00:00.000Z",
  "data": {
    "subscription": "...", "plan": "...", "subscriber": "...", "mint": "...",
    "amount": "1000000", "periodStartTs": "1793448000", "attemptNo": 1, "signature": "..."
  }
}
```

Token amounts and timestamps are strings (u64). Requests carry `webhook-id`, `webhook-timestamp`
and `webhook-signature` headers per the Standard Webhooks spec, so any of its libraries verifies them:

```ts
import { Webhook } from 'standardwebhooks';
const event = new Webhook(process.env.WEBHOOK_SECRET).verify(rawBody, headers); // throws if invalid
```

- **At-least-once.** Dedupe on `webhook-id` (the event id, stable across retries). Order is
  oldest-first but not guaranteed across retries.
- **Retries.** Any non-2xx response, redirect, or timeout (`WEBHOOK_TIMEOUT_MS`) is retried on
  `WEBHOOK_RETRY_SCHEDULE_SECS` (10s up to 24h, about 2 days in total), then marked `failed`.
  `POST /events/:id/redeliver` queues one again.
- **Rotation.** `WEBHOOK_SECRET` takes a comma-separated list; every request is signed with each,
  so receivers keep verifying while they switch to the new one.
- **Polling instead.** The same events are at `GET /events?after=<id>&type=&limit=`; events are
  recorded whether or not `WEBHOOK_URL` is set (and delivered from the start once it is).
- `payment.*` covers charges made by this worker. Pulls by other pullers show up as changes in
  the subscription snapshot; a full on-chain ledger needs event ingestion (see roadmap).

## Security notes

- The worker key only needs to be the plan owner or one of its `pullers`. Prefer a dedicated
  puller key over the merchant key — the merchant can rotate pullers with `updatePlan` if it leaks.
- `KEYPAIR_PATH` is a plain keypair file. Use a secrets manager / KMS-backed signer in production.
- Funds can only go to the plan's whitelisted `destinations` (or anywhere, if none are set).
- Verify webhook signatures and reject stale `webhook-timestamp`s (the libraries do both).
  Webhooks are notifications: before granting something valuable, confirm with
  `GET /entitlements/:wallet` or the transaction `signature`.

## Status and roadmap

v0.1. Tested three ways:

- unit and engine tests against an in-memory chain and embedded Postgres;
- read-only sync of real devnet data (~1k plans, ~900 subscriptions);
- end-to-end on Surfpool (mainnet fork, the deployed program, real USDC): the worker charges as a
  whitelisted puller, creates the merchant's token account, blocks an underfunded subscriber in
  preflight without sending, charges again only in the next period, stops after cancellation, and
  delivers every resulting event as a webhook that the reference `standardwebhooks` library verifies.

- [x] End-to-end test against Surfpool
- [x] Signed webhooks (`payment.succeeded`, `payment.failed`, `subscription.cancelled`, ...)
- [ ] `subscription.past_due` / entitlement-change events (time-based, needs a scheduler pass)
- [ ] Event ingestion (self-CPI events) for a full payment ledger, including pulls by other pullers
- [ ] Batching several charges per transaction
- [ ] Plan metadata JSON schema for `metadataUri`

## Development

```bash
pnpm test        # unit + engine tests (embedded Postgres, fake chain); e2e is skipped
pnpm typecheck
```

End-to-end against a local [Surfpool](https://github.com/txtx/surfpool) mainnet fork. The program
and USDC are loaded from mainnet on demand; time travel and token balances use Surfpool cheatcodes.

```bash
surfpool start --ci --no-tui --no-deploy --network mainnet   # in another terminal
pnpm test:e2e
```

Use Surfpool **1.6 or newer** (release binaries on GitHub). The Homebrew tap currently ships 1.0.0,
which rejects the program's `createPlan` with "insufficient funds for rent".

## License

MIT
