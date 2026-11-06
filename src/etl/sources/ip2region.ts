// SPDX-License-Identifier: MIT
import * as fs from "node:fs";
import { parseIp } from "../../ip";
import type { NormalizedRecord } from "../../types";

/**
 * v1: parses JSON-export form of ip2region. Future work: replace with
 * a real binary .xdb reader per https://gitee.com/lionsoul/ip2region
 */
export async function parseIp2regionXdb(xdbPath: string): Promise<NormalizedRecord[]> {
  const raw = fs.readFileSync(xdbPath, "utf8");
  const rows = JSON.parse(raw) as Array<{
    start: string;
    end: string;
    country: string;
    province?: string;
    city?: string;
    isp?: string;
  }>;

  const records: NormalizedRecord[] = [];
  for (const row of rows) {
    const start = parseIp(row.start);
    const end = parseIp(row.end);
    if (!start || !end) continue;
    const rec: NormalizedRecord = { startIp: start, endIp: end, source: "ip2region" };
    const cc = countryNameToCode(row.country);
    if (cc) {
      rec.countryCode = cc;
      rec.countryName = row.country;
    }
    if (row.province) rec.region = row.province;
    if (row.city) rec.city = row.city;
    if (row.isp) rec.isp = row.isp;
    records.push(rec);
  }
  return records;
}

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  中国: "CN",
  美国: "US",
  日本: "JP",
  韩国: "KR",
  英国: "GB",
  德国: "DE",
  法国: "FR",
  俄罗斯: "RU",
  加拿大: "CA",
  澳大利亚: "AU",
  巴西: "BR",
  印度: "IN",
};

function countryNameToCode(name: string): string | undefined {
  return COUNTRY_NAME_TO_CODE[name];
}
