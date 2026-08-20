-- SPDX-License-Identifier: MIT

-- Add a UNIQUE index on (start_ip, end_ip, country_source) so that
-- INSERT IGNORE below has row-level idempotency for seed rows
-- (country_source = 'seed'). This is safe because ETL rows use other
-- source values such as 'maxmind', so the index does not constrain them.
ALTER TABLE ip_ranges ADD UNIQUE INDEX uniq_seed (start_ip, end_ip, country_source);

INSERT IGNORE INTO ip_ranges
  (start_ip, end_ip, country_code, country_name, region, city, isp, asn, asn_org, country_source, city_source, isp_source, geo_source)
VALUES
  -- Public DNS (15 rows)
  (UNHEX('08080808'), UNHEX('08080808'), 'US', 'United States', 'California', 'Mountain View', 'Google Public DNS',     15169, 'Google LLC',                'seed','seed','seed','seed'),
  (UNHEX('08080404'), UNHEX('08080404'), 'US', 'United States', 'California', 'Mountain View', 'Google Public DNS',     15169, 'Google LLC',                'seed','seed','seed','seed'),
  (UNHEX('01010101'), UNHEX('01010101'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare DNS',        13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('01000001'), UNHEX('01000001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare DNS',        13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('09090909'), UNHEX('09090909'), 'CH', 'Switzerland',   'Zurich',    'Zurich',        'Quad9 DNS',             19281, 'Quad9',                     'seed','seed','seed','seed'),
  (UNHEX('95707070'), UNHEX('95707070'), 'CH', 'Switzerland',   'Zurich',    'Zurich',        'Quad9 DNS',             19281, 'Quad9',                     'seed','seed','seed','seed'),
  (UNHEX('72727272'), UNHEX('72727272'), 'CN', 'China',         'Jiangsu',   'Nanjing',       '114DNS',                4134,  'Chinanet',                  'seed','seed','seed','seed'),
  (UNHEX('72727373'), UNHEX('72727373'), 'CN', 'China',         'Jiangsu',   'Nanjing',       '114DNS',                4134,  'Chinanet',                  'seed','seed','seed','seed'),
  (UNHEX('DF050505'), UNHEX('DF050505'), 'CN', 'China',         'Zhejiang',  'Hangzhou',      'AliDNS',                37963, 'Alibaba Cloud',             'seed','seed','seed','seed'),
  (UNHEX('DF060606'), UNHEX('DF060606'), 'CN', 'China',         'Zhejiang',  'Hangzhou',      'AliDNS',                37963, 'Alibaba Cloud',             'seed','seed','seed','seed'),
  (UNHEX('B44C4C4C'), UNHEX('B44C4C4C'), 'CN', 'China',         'Beijing',   'Beijing',       'Baidu Public DNS',      38365, 'Baidu',                     'seed','seed','seed','seed'),
  (UNHEX('771D1D1D'), UNHEX('771D1D1D'), 'CN', 'China',         'Guangdong', 'Shenzhen',      'DNSPod',                45090, 'Tencent Cloud',             'seed','seed','seed','seed'),
  (UNHEX('771C1C1C'), UNHEX('771C1C1C'), 'CN', 'China',         'Guangdong', 'Shenzhen',      'DNSPod',                45090, 'Tencent Cloud',             'seed','seed','seed','seed'),
  (UNHEX('65E20406'), UNHEX('65E20406'), 'CN', 'China',         'Shanghai',  'Shanghai',      'China Telecom DNS',     4134,  'Chinanet',                  'seed','seed','seed','seed'),
  (UNHEX('DA1E7606'), UNHEX('DA1E7606'), 'CN', 'China',         'Beijing',   'Beijing',       'China Mobile DNS',      9808,  'China Mobile',              'seed','seed','seed','seed'),

  -- Cloudflare nodes (6 rows)
  (UNHEX('68100001'), UNHEX('68100001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('AC400001'), UNHEX('AC400001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('A29E0001'), UNHEX('A29E0001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('C6298001'), UNHEX('C6298001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('68120001'), UNHEX('68120001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('AC410001'), UNHEX('AC410001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),

  -- Apple (3 rows)
  (UNHEX('11000001'), UNHEX('11000001'), 'US', 'United States', 'California', 'Cupertino',     'Apple Inc',             714,   'Apple Inc.',                'seed','seed','seed','seed'),
  (UNHEX('11010101'), UNHEX('11010101'), 'US', 'United States', 'California', 'Cupertino',     'Apple Inc',             714,   'Apple Inc.',                'seed','seed','seed','seed'),
  (UNHEX('11FD0001'), UNHEX('11FD0001'), 'US', 'United States', 'California', 'Cupertino',     'Apple Inc',             714,   'Apple Inc.',                'seed','seed','seed','seed'),

  -- Microsoft (3 rows)
  (UNHEX('0D6B0432'), UNHEX('0D6B0432'), 'US', 'United States', 'Washington', 'Redmond',       'Microsoft Corp',        8075,  'Microsoft Corporation',     'seed','seed','seed','seed'),
  (UNHEX('0D6B0550'), UNHEX('0D6B0550'), 'US', 'United States', 'Washington', 'Redmond',       'Microsoft Corp',        8075,  'Microsoft Corporation',     'seed','seed','seed','seed'),
  (UNHEX('0D6B15C8'), UNHEX('0D6B15C8'), 'US', 'United States', 'Washington', 'Redmond',       'Microsoft Corp',        8075,  'Microsoft Corporation',     'seed','seed','seed','seed'),

  -- RFC reserved (4 ranges)
  (UNHEX('C0A80000'), UNHEX('C0A800FF'), NULL, 'Reserved (RFC 1918)', NULL, NULL, 'Private Network',     NULL, NULL,                                       'seed','seed','seed','seed'),
  (UNHEX('0A000000'), UNHEX('0A0000FF'), NULL, 'Reserved (RFC 1918)', NULL, NULL, 'Private Network',     NULL, NULL,                                       'seed','seed','seed','seed'),
  (UNHEX('7F000000'), UNHEX('7F0000FF'), NULL, 'Loopback (RFC 1122)', NULL, NULL, 'Loopback',            NULL, NULL,                                       'seed','seed','seed','seed'),
  (UNHEX('AC100000'), UNHEX('AC1000FF'), NULL, 'Reserved (RFC 1918)', NULL, NULL, 'Private Network',     NULL, NULL,                                       'seed','seed','seed','seed'),

  -- Additional public DNS / well-known services (19 rows to reach 50 total)
  (UNHEX('AC420001'), UNHEX('AC420001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('68120101'), UNHEX('68120101'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('68130001'), UNHEX('68130001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('A29F0001'), UNHEX('A29F0001'), 'US', 'United States', 'California', 'San Francisco', 'Cloudflare',           13335, 'Cloudflare, Inc.',          'seed','seed','seed','seed'),
  (UNHEX('08070808'), UNHEX('08070808'), 'US', 'United States', 'New Jersey', 'Jersey City',   'Comodo Secure DNS',     3356,  'Comodo Group',             'seed','seed','seed','seed'),
  (UNHEX('D043DEDE'), UNHEX('D043DEDE'), 'US', 'United States', 'California', 'San Francisco', 'OpenDNS',               36692, 'Cisco OpenDNS',            'seed','seed','seed','seed'),
  (UNHEX('D043DCDC'), UNHEX('D043DCDC'), 'US', 'United States', 'California', 'San Francisco', 'OpenDNS',               36692, 'Cisco OpenDNS',            'seed','seed','seed','seed'),
  (UNHEX('04020202'), UNHEX('04020202'), 'US', 'United States', 'California', 'San Jose',      'Level3 DNS',            3356,  'Level3 Parent',            'seed','seed','seed','seed'),
  (UNHEX('9C9A4601'), UNHEX('9C9A4601'), 'US', 'United States', 'California', 'Santa Clara',   'UltraDNS',              12008, 'Neustar',                  'seed','seed','seed','seed'),
  (UNHEX('4D580808'), UNHEX('4D580808'), 'RU', 'Russia',        'Moscow',     'Moscow',        'Yandex DNS',            13238, 'Yandex',                   'seed','seed','seed','seed'),
  (UNHEX('11200001'), UNHEX('11200001'), 'US', 'United States', 'California', 'Cupertino',     'Apple Inc',             714,   'Apple Inc.',               'seed','seed','seed','seed'),
  (UNHEX('11390001'), UNHEX('11390001'), 'US', 'United States', 'California', 'Cupertino',     'Apple iCloud',          714,   'Apple Inc.',               'seed','seed','seed','seed'),
  (UNHEX('0D6B2A0E'), UNHEX('0D6B2A0E'), 'US', 'United States', 'Washington', 'Redmond',       'Microsoft Corp',        8075,  'Microsoft Corporation',    'seed','seed','seed','seed'),
  (UNHEX('0D6B0698'), UNHEX('0D6B0698'), 'US', 'United States', 'Washington', 'Redmond',       'Microsoft Corp',        8075,  'Microsoft Corporation',    'seed','seed','seed','seed'),
  (UNHEX('17200001'), UNHEX('17200001'), 'US', 'United States', 'Massachusetts', 'Cambridge', 'Akamai Technologies',   20940, 'Akamai International',     'seed','seed','seed','seed'),
  (UNHEX('17D70001'), UNHEX('17D70001'), 'US', 'United States', 'Massachusetts', 'Cambridge', 'Akamai Technologies',   20940, 'Akamai International',     'seed','seed','seed','seed'),
  (UNHEX('68F42A01'), UNHEX('68F42A01'), 'US', 'United States', 'California', 'San Francisco', 'Twitter',               13414, 'Twitter Inc.',             'seed','seed','seed','seed'),
  (UNHEX('15770001'), UNHEX('15770001'), 'US', 'United States', 'California', 'Mountain View', 'Google',                15169, 'Google LLC',               'seed','seed','seed','seed'),
  (UNHEX('2A000001'), UNHEX('2A000001'), 'IE', 'Ireland',       'Leinster',  'Dublin',         'Facebook',              32934, 'Meta Platforms, Inc.',     'seed','seed','seed','seed');
