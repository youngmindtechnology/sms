-- Staff management: a person given a one-time temporary password must replace it at their
-- first sign-in. This flag records that. Existing credentials default to false, so nobody
-- already signed up is forced to change anything.
ALTER TABLE "user_credentials"
  ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
