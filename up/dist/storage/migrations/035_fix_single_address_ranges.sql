-- SPDX-License-Identifier: MIT
-- Repair single-address ranges written one address too wide.
--
-- writeConsensusRange() (the unknown-IP backfill and the random-IP
-- generator) used to store `end_ip = start_ip + 1` for a row that describes
-- exactly one address. Every other row in this table — the ETL's DB-IP
-- ranges, the demo seed, an .ipq import — holds an INCLUSIVE end address,
-- and findRange() tests `end_ip >= target` on that basis. So each of those
-- rows answered for its own address AND for the next one: a backfill that
-- resolved 203.0.113.7 also reported 203.0.113.8, an address no provider had
-- been asked about. `range_size` was written as the literal 1, which is the
-- same off-by-one expressed numerically (end - start).
--
-- The fix in the code writes `end_ip = start_ip` and `range_size = 0`. This
-- migration applies the same correction to rows an older build already
-- wrote, so an upgraded install stops mislabelling its neighbours.
--
-- Scoped to what the old writer alone produces: source 'multi-provider'
-- (only that flow writes it) together with range_size exactly 1. The
-- comparison is on those two columns rather than on `end_ip = start_ip + 1`
-- on purpose — BINARY(16) arithmetic in MySQL does not carry into the
-- preceding byte, so a start address ending in 0xFF would not match and
-- would silently escape the repair. Nothing else in the table carries that
-- pair: the ETL writes computed sizes, the seed writes 0, an operator's row
-- carries the size it was imported with. Re-running finds nothing to change.

UPDATE ip_ranges
   SET end_ip = start_ip,
       range_size = 0
 WHERE country_source = 'multi-provider'
   AND range_size = 1;
