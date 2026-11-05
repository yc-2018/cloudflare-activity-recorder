-- Drop the per-sample UUID from the stored JSON blobs.
--
-- Idempotency no longer needs a client-supplied id: across the full history,
-- (device_id, observed_at, process_name) is unique, so the merge path can use
-- that natural key to recognise a retried event. The client keeps sending its
-- UUID; the server simply ignores it.
--
-- Each tuple shrinks from 8 to 7 elements:
--   [observed_at, window_title, cpu, memory, battery, power_plugged, trigger]
--
-- The UUID accounted for ~36% of the stored JSON bytes.

UPDATE activity_days
   SET samples = (
         SELECT json_group_array(json_array(
                  json_extract(j.value, '$[0]'),
                  json_extract(j.value, '$[1]'),
                  json_extract(j.value, '$[2]'),
                  json_extract(j.value, '$[3]'),
                  json_extract(j.value, '$[4]'),
                  json_extract(j.value, '$[5]'),
                  json_extract(j.value, '$[6]')
                ))
           FROM json_each(activity_days.samples) j
       )
 WHERE json_array_length(samples) > 0
   AND json_array_length(json_extract(samples, '$[0]')) = 8;
