-- u64 token amounts are NUMERIC(20,0); unix timestamps are BIGINT.

CREATE TABLE IF NOT EXISTS plans (
    address          TEXT PRIMARY KEY,
    owner            TEXT        NOT NULL,
    plan_id          NUMERIC(20,0) NOT NULL,
    mint             TEXT        NOT NULL,
    amount           NUMERIC(20,0) NOT NULL,
    period_hours     BIGINT      NOT NULL,
    terms_created_at BIGINT      NOT NULL,
    end_ts           BIGINT      NOT NULL,
    status           SMALLINT    NOT NULL,
    destinations     TEXT[]      NOT NULL,
    pullers          TEXT[]      NOT NULL,
    metadata_uri     TEXT        NOT NULL,
    closed           BOOLEAN     NOT NULL DEFAULT FALSE,
    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    synced_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
    address                  TEXT PRIMARY KEY,
    plan                     TEXT        NOT NULL,
    subscriber               TEXT        NOT NULL,
    payer                    TEXT        NOT NULL,
    amount                   NUMERIC(20,0) NOT NULL,
    period_hours             BIGINT      NOT NULL,
    terms_created_at         BIGINT      NOT NULL,
    amount_pulled_in_period  NUMERIC(20,0) NOT NULL,
    current_period_start_ts  BIGINT      NOT NULL,
    expires_at_ts            BIGINT      NOT NULL,
    closed                   BOOLEAN     NOT NULL DEFAULT FALSE,
    first_seen_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    synced_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_plan_idx ON subscriptions (plan);
CREATE INDEX IF NOT EXISTS subscriptions_subscriber_idx ON subscriptions (subscriber);

-- One row per charge attempt. status: pending -> succeeded | failed.
CREATE TABLE IF NOT EXISTS charge_attempts (
    id               BIGSERIAL PRIMARY KEY,
    subscription     TEXT        NOT NULL,
    plan             TEXT        NOT NULL,
    period_start_ts  BIGINT      NOT NULL,
    attempt_no       INTEGER     NOT NULL,
    amount           NUMERIC(20,0) NOT NULL,
    status           TEXT        NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
    reason           TEXT,
    error            TEXT,
    signature        TEXT,
    next_retry_at    TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subscription, period_start_ts, attempt_no)
);
-- At most one in-flight or successful charge per subscription period: the
-- worker's idempotency guard if two workers or a restart race.
CREATE UNIQUE INDEX IF NOT EXISTS charge_attempts_one_live_per_period
    ON charge_attempts (subscription, period_start_ts)
    WHERE status IN ('pending', 'succeeded');
CREATE INDEX IF NOT EXISTS charge_attempts_status_idx ON charge_attempts (status);

CREATE TABLE IF NOT EXISTS sync_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
