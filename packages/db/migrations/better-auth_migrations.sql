CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL UNIQUE,
    "email_verified" BOOLEAN NOT NULL,
    "image" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT current_timestamp NOT NULL,
    "updated_at" TIMESTAMPTZ DEFAULT current_timestamp NOT NULL
);

CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "token" TEXT NOT NULL UNIQUE,
    "created_at" TIMESTAMPTZ DEFAULT current_timestamp NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE
);

CREATE TABLE "accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ,
    "refresh_token_expires_at" TIMESTAMPTZ,
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT current_timestamp NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE "verifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ DEFAULT current_timestamp NOT NULL,
    "updated_at" TIMESTAMPTZ DEFAULT current_timestamp NOT NULL
);

CREATE TABLE "jwks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "public_key" TEXT NOT NULL,
    "private_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ,
    "alg" TEXT,
    "crv" TEXT
);

CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");

CREATE INDEX "accounts_user_id_idx" ON "accounts" ("user_id");

CREATE INDEX "verifications_identifier_idx" ON "verifications" ("identifier");
