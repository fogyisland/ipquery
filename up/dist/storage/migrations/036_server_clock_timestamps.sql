-- SPDX-License-Identifier: MIT
--
-- Move the application-written timestamps into the server's own clock.
--
-- MySQL stamps a column with `DEFAULT CURRENT_TIMESTAMP` in the SERVER's
-- time zone, and the driver now reads those literals back in the same
-- zone, so every timestamp the database produced is already correct.
--
-- The columns below are the exception: the application hands MySQL a
-- JavaScript Date, and the driver used to serialise it as UTC while
-- MySQL wrote everything else in the server's zone. They are moved
-- forward by the server's offset so that the two agree.
--
-- The offset is derived from `@@global.time_zone` rather than from the
-- session, so it stays correct no matter which time zone the session
-- happens to be in, and it is zero on a UTC host — there the step
-- changes nothing.
--
-- This is a one-time step. The migration runner records it in
-- `schema_migrations`, so it never runs twice.

SET @server_offset_sec = TIMESTAMPDIFF(
  SECOND,
  CONVERT_TZ(UTC_TIMESTAMP(), @@global.time_zone, '+00:00'),
  UTC_TIMESTAMP()
);

-- A session that outlives the change must not be cut short by it.
UPDATE sessions
   SET expires_at = DATE_ADD(expires_at, INTERVAL @server_offset_sec SECOND)
 WHERE expires_at IS NOT NULL;

-- A pending e-mail verification and a pending password reset are the
-- same: the link in the operator's inbox has to keep working.
UPDATE email_verifications
   SET expires_at = DATE_ADD(expires_at, INTERVAL @server_offset_sec SECOND)
 WHERE expires_at IS NOT NULL;

UPDATE password_resets
   SET expires_at = DATE_ADD(expires_at, INTERVAL @server_offset_sec SECOND)
 WHERE expires_at IS NOT NULL;

-- The circuit breaker's cooldown. Re-enabling it early is harmless;
-- leaving it stuck is not.
UPDATE ingest_providers
   SET auto_reenable_at = DATE_ADD(auto_reenable_at, INTERVAL @server_offset_sec SECOND)
 WHERE auto_reenable_at IS NOT NULL;

-- An export job's finish time.
UPDATE range_exports
   SET finished_at = DATE_ADD(finished_at, INTERVAL @server_offset_sec SECOND)
 WHERE finished_at IS NOT NULL;

-- The ETL's stage tables. These are the only place where the pipeline
-- writes a moment itself: every other timestamp it records comes from
-- NOW(3). They matter because the pipeline reads them back against
-- NOW(3) to work out how long a stage took — across two clocks, that
-- duration was off by the server's offset.
UPDATE etl_run_downloads
   SET started_at = DATE_ADD(started_at, INTERVAL @server_offset_sec SECOND),
       finished_at = DATE_ADD(finished_at, INTERVAL @server_offset_sec SECOND)
 WHERE started_at IS NOT NULL;

UPDATE etl_run_parses
   SET started_at = DATE_ADD(started_at, INTERVAL @server_offset_sec SECOND),
       finished_at = DATE_ADD(finished_at, INTERVAL @server_offset_sec SECOND)
 WHERE started_at IS NOT NULL;

UPDATE etl_run_inserts
   SET started_at = DATE_ADD(started_at, INTERVAL @server_offset_sec SECOND),
       finished_at = DATE_ADD(finished_at, INTERVAL @server_offset_sec SECOND)
 WHERE started_at IS NOT NULL;

UPDATE etl_run_swaps
   SET started_at = DATE_ADD(started_at, INTERVAL @server_offset_sec SECOND),
       finished_at = DATE_ADD(finished_at, INTERVAL @server_offset_sec SECOND)
 WHERE started_at IS NOT NULL;

UPDATE etl_run_dedupe
   SET started_at = DATE_ADD(started_at, INTERVAL @server_offset_sec SECOND),
       finished_at = DATE_ADD(finished_at, INTERVAL @server_offset_sec SECOND)
 WHERE started_at IS NOT NULL;
