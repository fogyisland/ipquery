-- SPDX-License-Identifier: MIT
-- Retire ipinfo.io as an ingest provider.
--
-- It was originally kept: unlike the three removed in migration 028 it does
-- answer. But it requires an API key on every call, and an install without
-- one gets an abstention from it every round — a provider that looks enabled
-- and contributes nothing. The three that remain need no key at all.
--
-- This is a separate migration rather than an edit to 028 because 028 had
-- already been applied here: a migration that has run is history, and
-- rewriting it means the change silently never reaches any install that
-- applied the old version. That is exactly what happened — the row survived
-- a "database already up to date".
--
-- Scoped to the one name. A custom provider an operator added stays.

DELETE FROM provider_call_counter
 WHERE provider_name = 'ipinfo';

DELETE FROM provider_call_counter_minute
 WHERE provider_name = 'ipinfo';

DELETE FROM provider_error_log
 WHERE provider_name = 'ipinfo';

DELETE FROM ingest_providers
 WHERE name = 'ipinfo';
