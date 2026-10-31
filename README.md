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

No changes to the audited program; it builds on `@solana/subscriptions`.

## Quick start

```bash
pnpm install
cp .env.example .env            # edit RPC_URL, KEYPAIR_PATH, ...
pnpm billing migrate
pnpm billing sync               # one snapshot
pnpm billing charge             # one charge cycle (needs KEYPAIR_PATH)
pnpm dev                        # sync + charge loops + API on :8787
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
`GET /charges?status=failed`. Set `API_KEY` to require `Authorization: Bearer <key>`; otherwise
keep the API bound to localhost.

## Security notes

- The worker key only needs to be the plan owner or one of its `pullers`. Prefer a dedicated
  puller key over the merchant key — the merchant can rotate pullers with `updatePlan` if it leaks.
- `KEYPAIR_PATH` is a plain keypair file. Use a secrets manager / KMS-backed signer in production.
- Funds can only go to the plan's whitelisted `destinations` (or anywhere, if none are set).

## Status and roadmap

v0.1. Tested three ways:

- unit and engine tests against an in-memory chain and embedded Postgres;
- read-only sync of real devnet data (~1k plans, ~900 subscriptions);
- end-to-end on Surfpool (mainnet fork, the deployed program, real USDC): the worker charges as a
  whitelisted puller, creates the merchant's token account, blocks an underfunded subscriber in
  preflight without sending, charges again only in the next period, and stops after cancellation.

- [x] End-to-end test against Surfpool
- [ ] Signed webhooks (`payment.succeeded`, `payment.failed`, `subscription.cancelled`, ...)
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
