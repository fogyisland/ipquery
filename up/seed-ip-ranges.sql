-- SPDX-License-Identifier: MIT

-- Seed rows: a handful of well-known IPs so that /lookup answers
-- something before the first ETL run has loaded the real library.
--
-- Byte order matters. start_ip / end_ip are BINARY(16) and every
-- runtime path — parseIp() in src/ip.ts, the DB-IP and MaxMind
-- parsers, and findRange()'s query parameter — stores an IPv4
-- address as 16 bytes with the four address bytes in the LAST four
-- positions (the "::a.b.c.d" form, i.e. `00...00 08 08 08 08`).
--
-- These rows were originally written as UNHEX('08080808') — four
-- bytes, left-aligned in the column. MySQL compares the padded
-- values, so `00...00 08 08 08 08` sorted BELOW the 16-byte form,
-- and no query could ever match them: every seeded IP was
-- unreachable through /lookup. The values below are the corrected
-- 16-byte form.

-- Add a UNIQUE index on (start_ip, end_ip, country_source) so that
-- INSERT IGNORE below has row-level idempotency for seed rows
-- (country_source = 'seed'). This is safe because ETL rows use other
-- source values such as 'maxmind', so the index does not constrain them.
ALTER TABLE ip_ranges ADD UNIQUE INDEX uniq_seed (start_ip, end_ip, country_source);

INSERT IGNORE INTO ip_ranges
  (start_ip, end_ip, country_code, country_name, region, city, isp, asn, asn_org, country_source, city_source, isp_source, geo_source)
VALUES
  -- Public DNS (15 rows)
  (UNHEX('00000000000000000000000008080808'), UNHEX('00000000000000000000000008080808'), 'US', 'United States', 'California', 'Mountain View', 'Google Public DNS',     15169, 'Google LLC',                'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000008080404'), UNHEX('00000000000000000000000008080404'), 'US', 'United States', 'California', 'Mountain View', 'Google Public DNS',     15169, 'Google LLC',                'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000001010101'), UNHEX('00000000000000000000000001010101'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare DNS',        13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000001000001'), UNHEX('00000000000000000000000001000001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare DNS',        13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000009090909'), UNHEX('00000000000000000000000009090909'), 'CH', 'Switzerland',   'Zurich',    'Zurich',        'Quad9 DNS',             19281, 'Quad9',                     'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000095707070'), UNHEX('00000000000000000000000095707070'), 'CH', 'Switzerland',   'Zurich',    'Zurich',        'Quad9 DNS',             19281, 'Quad9',                     'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000072727272'), UNHEX('00000000000000000000000072727272'), 'CN', 'China',         'Jiangsu',   'Nanjing',       '114DNS',                4134,  'Chinanet',                  'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000072727373'), UNHEX('00000000000000000000000072727373'), 'CN', 'China',         'Jiangsu',   'Nanjing',       '114DNS',                4134,  'Chinanet',                  'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000DF050505'), UNHEX('000000000000000000000000DF050505'), 'CN', 'China',         'Zhejiang',  'Hangzhou',      'AliDNS',                37963, 'Alibaba Cloud',             'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000DF060606'), UNHEX('000000000000000000000000DF060606'), 'CN', 'China',         'Zhejiang',  'Hangzhou',      'AliDNS',                37963, 'Alibaba Cloud',             'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000B44C4C4C'), UNHEX('000000000000000000000000B44C4C4C'), 'CN', 'China',         'Beijing',   'Beijing',       'Baidu Public DNS',      38365, 'Baidu',                     'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000771D1D1D'), UNHEX('000000000000000000000000771D1D1D'), 'CN', 'China',         'Guangdong', 'Shenzhen',      'DNSPod',                45090, 'Tencent Cloud',             'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000771C1C1C'), UNHEX('000000000000000000000000771C1C1C'), 'CN', 'China',         'Guangdong', 'Shenzhen',      'DNSPod',                45090, 'Tencent Cloud',             'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000065E20406'), UNHEX('00000000000000000000000065E20406'), 'CN', 'China',         'Shanghai',  'Shanghai',      'China Telecom DNS',     4134,  'Chinanet',                  'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000DA1E7606'), UNHEX('000000000000000000000000DA1E7606'), 'CN', 'China',         'Beijing',   'Beijing',       'China Mobile DNS',      9808,  'China Mobile',              'seed','seed','seed','seed'),

  -- Cloudflare nodes (6 rows)
  (UNHEX('00000000000000000000000068100001'), UNHEX('00000000000000000000000068100001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000AC400001'), UNHEX('000000000000000000000000AC400001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000A29E0001'), UNHEX('000000000000000000000000A29E0001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000C6298001'), UNHEX('000000000000000000000000C6298001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000068120001'), UNHEX('00000000000000000000000068120001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000AC410001'), UNHEX('000000000000000000000000AC410001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),

  -- Apple (3 rows)
  (UNHEX('00000000000000000000000011000001'), UNHEX('00000000000000000000000011000001'), 'US', 'United States', 'California', 'Cupertino',     'Apple Inc',             714,   'Apple Inc.',                'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000011010101'), UNHEX('00000000000000000000000011010101'), 'US', 'United States', 'California', 'Cupertino',     'Apple Inc',             714,   'Apple Inc.',                'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000011FD0001'), UNHEX('00000000000000000000000011FD0001'), 'US', 'United States', 'California', 'Cupertino',     'Apple Inc',             714,   'Apple Inc.',                'seed','seed','seed','seed'),

  -- Microsoft (3 rows)
  (UNHEX('0000000000000000000000000D6B0432'), UNHEX('0000000000000000000000000D6B0432'), 'US', 'United States', 'Washington', 'Redmond',       'Microsoft Corp',        8075,  'Microsoft Corporation',     'seed','seed','seed','seed'),
  (UNHEX('0000000000000000000000000D6B0550'), UNHEX('0000000000000000000000000D6B0550'), 'US', 'United States', 'Washington', 'Redmond',       'Microsoft Corp',        8075,  'Microsoft Corporation',     'seed','seed','seed','seed'),
  (UNHEX('0000000000000000000000000D6B15C8'), UNHEX('0000000000000000000000000D6B15C8'), 'US', 'United States', 'Washington', 'Redmond',       'Microsoft Corp',        8075,  'Microsoft Corporation',     'seed','seed','seed','seed'),

  -- RFC reserved (4 ranges)
  (UNHEX('000000000000000000000000C0A80000'), UNHEX('000000000000000000000000C0A800FF'), NULL, 'Reserved (RFC 1918)', NULL, NULL, 'Private Network',     NULL, NULL,                                       'seed','seed','seed','seed'),
  (UNHEX('0000000000000000000000000A000000'), UNHEX('0000000000000000000000000A0000FF'), NULL, 'Reserved (RFC 1918)', NULL, NULL, 'Private Network',     NULL, NULL,                                       'seed','seed','seed','seed'),
  (UNHEX('0000000000000000000000007F000000'), UNHEX('0000000000000000000000007F0000FF'), NULL, 'Loopback (RFC 1122)', NULL, NULL, 'Loopback',            NULL, NULL,                                       'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000AC100000'), UNHEX('000000000000000000000000AC1000FF'), NULL, 'Reserved (RFC 1918)', NULL, NULL, 'Private Network',     NULL, NULL,                                       'seed','seed','seed','seed'),

  -- Additional public DNS / well-known services (19 rows to reach 50 total)
  (UNHEX('000000000000000000000000AC420001'), UNHEX('000000000000000000000000AC420001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000068120101'), UNHEX('00000000000000000000000068120101'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000068130001'), UNHEX('00000000000000000000000068130001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000A29F0001'), UNHEX('000000000000000000000000A29F0001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000008070808'), UNHEX('00000000000000000000000008070808'), 'US', 'United States', 'New Jersey', 'Jersey City',   'Comodo Secure DNS',     3356,  'Comodo Group',             'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000D043DEDE'), UNHEX('000000000000000000000000D043DEDE'), 'US', 'United States', 'California', 'San Francisco', 'OpenDNS',               36692, 'Cisco OpenDNS',            'seed','seed','seed','seed'),
  (UNHEX('000000000000000000000000D043DCDC'), UNHEX('000000000000000000000000D043DCDC'), 'US', 'United States', 'California', 'San Francisco', 'OpenDNS',               36692, 'Cisco OpenDNS',            'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000004020202'), UNHEX('00000000000000000000000004020202'), 'US', 'United States', 'California', 'San Jose',      'Level3 DNS',            3356,  'Level3 Parent',            'seed','seed','seed','seed'),
  (UNHEX('0000000000000000000000009C9A4601'), UNHEX('0000000000000000000000009C9A4601'), 'US', 'United States', 'California', 'Santa Clara',   'UltraDNS',              12008, 'Neustar',                  'seed','seed','seed','seed'),
  (UNHEX('0000000000000000000000004D580808'), UNHEX('0000000000000000000000004D580808'), 'RU', 'Russia',        'Moscow',     'Moscow',        'Yandex DNS',            13238, 'Yandex',                   'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000011200001'), UNHEX('00000000000000000000000011200001'), 'US', 'United States', 'California', 'Cupertino',     'Apple Inc',             714,   'Apple Inc.',               'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000011390001'), UNHEX('00000000000000000000000011390001'), 'US', 'United States', 'California', 'Cupertino',     'Apple iCloud',          714,   'Apple Inc.',               'seed','seed','seed','seed'),
  (UNHEX('0000000000000000000000000D6B2A0E'), UNHEX('0000000000000000000000000D6B2A0E'), 'US', 'United States', 'Washington', 'Redmond',       'Microsoft Corp',        8075,  'Microsoft Corporation',    'seed','seed','seed','seed'),
  (UNHEX('0000000000000000000000000D6B0698'), UNHEX('0000000000000000000000000D6B0698'), 'US', 'United States', 'Washington', 'Redmond',       'Microsoft Corp',        8075,  'Microsoft Corporation',    'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000017200001'), UNHEX('00000000000000000000000017200001'), 'US', 'United States', 'Massachusetts', 'Cambridge', 'Akamai Technologies',   20940, 'Akamai International',     'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000017D70001'), UNHEX('00000000000000000000000017D70001'), 'US', 'United States', 'Massachusetts', 'Cambridge', 'Akamai Technologies',   20940, 'Akamai International',     'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000068F42A01'), UNHEX('00000000000000000000000068F42A01'), 'US', 'United States', 'California', 'San Francisco', 'Twitter',               13414, 'Twitter Inc.',             'seed','seed','seed','seed'),
  (UNHEX('00000000000000000000000015770001'), UNHEX('00000000000000000000000015770001'), 'US', 'United States', 'California', 'Mountain View', 'Google',                15169, 'Google LLC',               'seed','seed','seed','seed'),
  (UNHEX('0000000000000000000000002A000001'), UNHEX('0000000000000000000000002A000001'), 'IE', 'Ireland',       'Leinster',  'Dublin',         'Facebook',              32934, 'Meta Platforms, Inc.',     'seed','seed','seed','seed');
