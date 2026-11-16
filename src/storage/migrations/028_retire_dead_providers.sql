-- SPDX-License-Identifier: MIT
-- Retire two ingest providers that never answered.
--
-- `ipapi.co`, `freeipapi.com` and `iplocate.io` were part of the original
-- five-provider fan-out (migration 016). Measured against the addresses in
-- this library their success rate was effectively zero, so the votes in
-- every round went to providers that never answered: the backfill spent
-- its quota and wrote nothing. What remains — ip-api and ipinfo — is the
-- pair that actually responds.
--
-- Removing them from the seed alone would not be enough. An install that
-- has been running since 016 already carries their rows, and
-- `buildProvidersFromConfig` turns any enabled row into a live provider —
-- so the rows have to go too.
--
-- Scoped to the three names: any custom provider an operator added, and
-- the two providers that do answer, are untouched.

DELETE FROM provider_call_counter
 WHERE provider_name IN ('ipapi-co', 'freeipapi', 'iplocate');

DELETE FROM provider_call_counter_minute
 WHERE provider_name IN ('ipapi-co', 'freeipapi', 'iplocate');

DELETE FROM provider_error_log
 WHERE provider_name IN ('ipapi-co', 'freeipapi', 'iplocate');

DELETE FROM ingest_providers
 WHERE name IN ('ipapi-co', 'freeipapi', 'iplocate');
