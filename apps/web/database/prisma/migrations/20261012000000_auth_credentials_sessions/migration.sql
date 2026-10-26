-- Authentication storage: password credentials and server-side sessions.
--
-- Additive only: creates two new tables. No existing table, constraint or
-- migration is altered. Written for PostgreSQL 16-18 (no version-specific syntax).
--
-- Design notes
--  * Credentials live in their own table, NOT on "users", so an ordinary
--    "SELECT * FROM users" can never return a password hash.
--  * Sessions store only a SHA-256 hash of the opaque cookie token (32 bytes).
--    A database leak therefore does not yield usable session cookies.
--  * A session's active school must be one the user has a membership in; this is
--    enforced by a composite foreign key to school_memberships(school_id, user_id).
--    Whether that membership is still ACTIVE is checked by the API on every request.
--  * All foreign keys are RESTRICT (no cascades), consistent with the earlier migrations.

-- CreateTable
CREATE TABLE "user_credentials" (
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_credentials_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "csrf_token_hash" BYTEA NOT NULL,
    "active_school_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- MATCH SIMPLE (the default): when active_school_id is NULL the check is skipped;
-- when it is set, (active_school_id, user_id) must be an existing membership.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_school_id_user_id_fkey"
  FOREIGN KEY ("active_school_id", "user_id") REFERENCES "school_memberships"("school_id", "user_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Integrity checks
ALTER TABLE "user_credentials"
  ADD CONSTRAINT "user_credentials_algorithm_chk"
    CHECK ("algorithm" IN ('argon2id', 'scrypt')),
  ADD CONSTRAINT "user_credentials_hash_format_chk"
    CHECK (
      char_length("password_hash") BETWEEN 20 AND 512
      AND (
        ("algorithm" = 'argon2id' AND "password_hash" LIKE '$argon2id$%')
        OR ("algorithm" = 'scrypt' AND "password_hash" LIKE 'scrypt$%')
      )
    ),
  ADD CONSTRAINT "user_credentials_failed_count_chk"
    CHECK ("failed_login_count" >= 0);

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_token_hash_len_chk"
    CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "sessions_csrf_hash_len_chk"
    CHECK (octet_length("csrf_token_hash") = 32),
  ADD CONSTRAINT "sessions_expiry_chk"
    CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "sessions_revocation_chk"
    CHECK (
      ("revoked_at" IS NULL AND "revoked_reason" IS NULL)
      OR ("revoked_at" IS NOT NULL AND "revoked_at" >= "created_at"
          AND "revoked_reason" IS NOT NULL
          AND "revoked_reason" IN ('logout', 'password_changed', 'admin_revoked', 'user_disabled', 'expired_cleanup'))
    );
