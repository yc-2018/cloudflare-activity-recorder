-- The month/year overview is now computed directly from activity_days in the
-- Worker, so the separate hourly rollup table is no longer used. Drop it to
-- reclaim storage. Safe to run whether or not it exists.
DROP TABLE IF EXISTS activity_rollup;
