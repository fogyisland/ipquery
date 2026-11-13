"use strict";
// SPDX-License-Identifier: MIT
// ISO 3166-1 alpha-2 country / region names.
//
// WHY THIS EXISTS
//
// The `ip_ranges` table has a `country_name` column, but in practice it is
// NULL for every row: DB-IP's free CSVs carry a country *code* only (the
// city-lite file is `start,end,continent,country,region,city,lat,lon` —
// there is no country-name column), and MaxMind — the one source that
// could fill the name — has never run through the ETL pipeline because
// it needs a licence key the project doesn't have.
//
// The result is that a lookup for a Hong Kong address answered "HK" and
// labelled it "国家" (country), when Hong Kong is a region and the
// answer should read "香港".
//
// ISO 3166-1 alpha-2 is a closed, stable set of 249 codes, so the names
// can simply be compiled in. No new dependency, no data source, no ETL
// change.
//
// Two names per code: `en` for machine-readable API output, `zh` for
// the Chinese UI. Codes that are territories rather than sovereign
// states (Hong Kong, Macao, Taiwan, the British Overseas Territories,
// the French overseas departments, …) are listed under their own code —
// which is what the address data actually says.
Object.defineProperty(exports, "__esModule", { value: true });
exports.countryNamesFor = countryNamesFor;
exports.englishCountryName = englishCountryName;
exports.chineseCountryName = chineseCountryName;
exports.knownCountryCodes = knownCountryCodes;
/**
 * Every ISO 3166-1 alpha-2 code, in alphabetical order by code.
 *
 * The list is deliberately complete rather than "the countries people
 * query": a geo-IP service that answers "HK" for a Hong Kong address and
 * "???" for an unusual one is worse than useless for the second case.
 */
const COUNTRY_NAMES = {
    AD: { en: "Andorra", zh: "安道尔" },
    AE: { en: "United Arab Emirates", zh: "阿联酋" },
    AF: { en: "Afghanistan", zh: "阿富汗" },
    AG: { en: "Antigua and Barbuda", zh: "安提瓜和巴布达" },
    AI: { en: "Anguilla", zh: "安圭拉" },
    AL: { en: "Albania", zh: "阿尔巴尼亚" },
    AM: { en: "Armenia", zh: "亚美尼亚" },
    AO: { en: "Angola", zh: "安哥拉" },
    AQ: { en: "Antarctica", zh: "南极洲" },
    AR: { en: "Argentina", zh: "阿根廷" },
    AS: { en: "American Samoa", zh: "美属萨摩亚" },
    AT: { en: "Austria", zh: "奥地利" },
    AU: { en: "Australia", zh: "澳大利亚" },
    AW: { en: "Aruba", zh: "阿鲁巴" },
    AX: { en: "Åland Islands", zh: "奥兰群岛" },
    AZ: { en: "Azerbaijan", zh: "阿塞拜疆" },
    BA: { en: "Bosnia and Herzegovina", zh: "波黑" },
    BB: { en: "Barbados", zh: "巴巴多斯" },
    BD: { en: "Bangladesh", zh: "孟加拉国" },
    BE: { en: "Belgium", zh: "比利时" },
    BF: { en: "Burkina Faso", zh: "布基纳法索" },
    BG: { en: "Bulgaria", zh: "保加利亚" },
    BH: { en: "Bahrain", zh: "巴林" },
    BI: { en: "Burundi", zh: "布隆迪" },
    BJ: { en: "Benin", zh: "贝宁" },
    BL: { en: "Saint Barthélemy", zh: "圣巴泰勒米" },
    BM: { en: "Bermuda", zh: "百慕大" },
    BN: { en: "Brunei", zh: "文莱" },
    BO: { en: "Bolivia", zh: "玻利维亚" },
    BQ: { en: "Caribbean Netherlands", zh: "荷属加勒比" },
    BR: { en: "Brazil", zh: "巴西" },
    BS: { en: "Bahamas", zh: "巴哈马" },
    BT: { en: "Bhutan", zh: "不丹" },
    BV: { en: "Bouvet Island", zh: "布韦岛" },
    BW: { en: "Botswana", zh: "博茨瓦纳" },
    BY: { en: "Belarus", zh: "白俄罗斯" },
    BZ: { en: "Belize", zh: "伯利兹" },
    CA: { en: "Canada", zh: "加拿大" },
    CC: { en: "Cocos (Keeling) Islands", zh: "科科斯群岛" },
    CD: { en: "DR Congo", zh: "刚果（金）" },
    CF: { en: "Central African Republic", zh: "中非共和国" },
    CG: { en: "Republic of the Congo", zh: "刚果（布）" },
    CH: { en: "Switzerland", zh: "瑞士" },
    CI: { en: "Côte d'Ivoire", zh: "科特迪瓦" },
    CK: { en: "Cook Islands", zh: "库克群岛" },
    CL: { en: "Chile", zh: "智利" },
    CM: { en: "Cameroon", zh: "喀麦隆" },
    CN: { en: "China", zh: "中国" },
    CO: { en: "Colombia", zh: "哥伦比亚" },
    CR: { en: "Costa Rica", zh: "哥斯达黎加" },
    CU: { en: "Cuba", zh: "古巴" },
    CV: { en: "Cape Verde", zh: "佛得角" },
    CW: { en: "Curaçao", zh: "库拉索" },
    CX: { en: "Christmas Island", zh: "圣诞岛" },
    CY: { en: "Cyprus", zh: "塞浦路斯" },
    CZ: { en: "Czechia", zh: "捷克" },
    DE: { en: "Germany", zh: "德国" },
    DJ: { en: "Djibouti", zh: "吉布提" },
    DK: { en: "Denmark", zh: "丹麦" },
    DM: { en: "Dominica", zh: "多米尼克" },
    DO: { en: "Dominican Republic", zh: "多米尼加" },
    DZ: { en: "Algeria", zh: "阿尔及利亚" },
    EC: { en: "Ecuador", zh: "厄瓜多尔" },
    EE: { en: "Estonia", zh: "爱沙尼亚" },
    EG: { en: "Egypt", zh: "埃及" },
    EH: { en: "Western Sahara", zh: "西撒哈拉" },
    ER: { en: "Eritrea", zh: "厄立特里亚" },
    ES: { en: "Spain", zh: "西班牙" },
    ET: { en: "Ethiopia", zh: "埃塞俄比亚" },
    FI: { en: "Finland", zh: "芬兰" },
    FJ: { en: "Fiji", zh: "斐济" },
    FK: { en: "Falkland Islands", zh: "福克兰群岛" },
    FM: { en: "Micronesia", zh: "密克罗尼西亚" },
    FO: { en: "Faroe Islands", zh: "法罗群岛" },
    FR: { en: "France", zh: "法国" },
    GA: { en: "Gabon", zh: "加蓬" },
    GB: { en: "United Kingdom", zh: "英国" },
    GD: { en: "Grenada", zh: "格林纳达" },
    GE: { en: "Georgia", zh: "格鲁吉亚" },
    GF: { en: "French Guiana", zh: "法属圭亚那" },
    GG: { en: "Guernsey", zh: "根西" },
    GH: { en: "Ghana", zh: "加纳" },
    GI: { en: "Gibraltar", zh: "直布罗陀" },
    GL: { en: "Greenland", zh: "格陵兰" },
    GM: { en: "Gambia", zh: "冈比亚" },
    GN: { en: "Guinea", zh: "几内亚" },
    GP: { en: "Guadeloupe", zh: "瓜德罗普" },
    GQ: { en: "Equatorial Guinea", zh: "赤道几内亚" },
    GR: { en: "Greece", zh: "希腊" },
    GS: { en: "South Georgia and the South Sandwich Islands", zh: "南乔治亚和南桑威奇群岛" },
    GT: { en: "Guatemala", zh: "危地马拉" },
    GU: { en: "Guam", zh: "关岛" },
    GW: { en: "Guinea-Bissau", zh: "几内亚比绍" },
    GY: { en: "Guyana", zh: "圭亚那" },
    HK: { en: "Hong Kong", zh: "香港" },
    HM: { en: "Heard Island and McDonald Islands", zh: "赫德岛和麦克唐纳群岛" },
    HN: { en: "Honduras", zh: "洪都拉斯" },
    HR: { en: "Croatia", zh: "克罗地亚" },
    HT: { en: "Haiti", zh: "海地" },
    HU: { en: "Hungary", zh: "匈牙利" },
    ID: { en: "Indonesia", zh: "印度尼西亚" },
    IE: { en: "Ireland", zh: "爱尔兰" },
    IL: { en: "Israel", zh: "以色列" },
    IM: { en: "Isle of Man", zh: "马恩岛" },
    IN: { en: "India", zh: "印度" },
    IO: { en: "British Indian Ocean Territory", zh: "英属印度洋领地" },
    IQ: { en: "Iraq", zh: "伊拉克" },
    IR: { en: "Iran", zh: "伊朗" },
    IS: { en: "Iceland", zh: "冰岛" },
    IT: { en: "Italy", zh: "意大利" },
    JE: { en: "Jersey", zh: "泽西" },
    JM: { en: "Jamaica", zh: "牙买加" },
    JO: { en: "Jordan", zh: "约旦" },
    JP: { en: "Japan", zh: "日本" },
    KE: { en: "Kenya", zh: "肯尼亚" },
    KG: { en: "Kyrgyzstan", zh: "吉尔吉斯斯坦" },
    KH: { en: "Cambodia", zh: "柬埔寨" },
    KI: { en: "Kiribati", zh: "基里巴斯" },
    KM: { en: "Comoros", zh: "科摩罗" },
    KN: { en: "Saint Kitts and Nevis", zh: "圣基茨和尼维斯" },
    KP: { en: "North Korea", zh: "朝鲜" },
    KR: { en: "South Korea", zh: "韩国" },
    KW: { en: "Kuwait", zh: "科威特" },
    KY: { en: "Cayman Islands", zh: "开曼群岛" },
    KZ: { en: "Kazakhstan", zh: "哈萨克斯坦" },
    LA: { en: "Laos", zh: "老挝" },
    LB: { en: "Lebanon", zh: "黎巴嫩" },
    LC: { en: "Saint Lucia", zh: "圣卢西亚" },
    LI: { en: "Liechtenstein", zh: "列支敦士登" },
    LK: { en: "Sri Lanka", zh: "斯里兰卡" },
    LR: { en: "Liberia", zh: "利比里亚" },
    LS: { en: "Lesotho", zh: "莱索托" },
    LT: { en: "Lithuania", zh: "立陶宛" },
    LU: { en: "Luxembourg", zh: "卢森堡" },
    LV: { en: "Latvia", zh: "拉脱维亚" },
    LY: { en: "Libya", zh: "利比亚" },
    MA: { en: "Morocco", zh: "摩洛哥" },
    MC: { en: "Monaco", zh: "摩纳哥" },
    MD: { en: "Moldova", zh: "摩尔多瓦" },
    ME: { en: "Montenegro", zh: "黑山" },
    MF: { en: "Saint Martin", zh: "圣马丁" },
    MG: { en: "Madagascar", zh: "马达加斯加" },
    MH: { en: "Marshall Islands", zh: "马绍尔群岛" },
    MK: { en: "North Macedonia", zh: "北马其顿" },
    ML: { en: "Mali", zh: "马里" },
    MM: { en: "Myanmar", zh: "缅甸" },
    MN: { en: "Mongolia", zh: "蒙古" },
    MO: { en: "Macao", zh: "澳门" },
    MP: { en: "Northern Mariana Islands", zh: "北马里亚纳群岛" },
    MQ: { en: "Martinique", zh: "马提尼克" },
    MR: { en: "Mauritania", zh: "毛里塔尼亚" },
    MS: { en: "Montserrat", zh: "蒙特塞拉特" },
    MT: { en: "Malta", zh: "马耳他" },
    MU: { en: "Mauritius", zh: "毛里求斯" },
    MV: { en: "Maldives", zh: "马尔代夫" },
    MW: { en: "Malawi", zh: "马拉维" },
    MX: { en: "Mexico", zh: "墨西哥" },
    MY: { en: "Malaysia", zh: "马来西亚" },
    MZ: { en: "Mozambique", zh: "莫桑比克" },
    NA: { en: "Namibia", zh: "纳米比亚" },
    NC: { en: "New Caledonia", zh: "新喀里多尼亚" },
    NE: { en: "Niger", zh: "尼日尔" },
    NF: { en: "Norfolk Island", zh: "诺福克岛" },
    NG: { en: "Nigeria", zh: "尼日利亚" },
    NI: { en: "Nicaragua", zh: "尼加拉瓜" },
    NL: { en: "Netherlands", zh: "荷兰" },
    NO: { en: "Norway", zh: "挪威" },
    NP: { en: "Nepal", zh: "尼泊尔" },
    NR: { en: "Nauru", zh: "瑙鲁" },
    NU: { en: "Niue", zh: "纽埃" },
    NZ: { en: "New Zealand", zh: "新西兰" },
    OM: { en: "Oman", zh: "阿曼" },
    PA: { en: "Panama", zh: "巴拿马" },
    PE: { en: "Peru", zh: "秘鲁" },
    PF: { en: "French Polynesia", zh: "法属波利尼西亚" },
    PG: { en: "Papua New Guinea", zh: "巴布亚新几内亚" },
    PH: { en: "Philippines", zh: "菲律宾" },
    PK: { en: "Pakistan", zh: "巴基斯坦" },
    PL: { en: "Poland", zh: "波兰" },
    PM: { en: "Saint Pierre and Miquelon", zh: "圣皮埃尔和密克隆" },
    PN: { en: "Pitcairn Islands", zh: "皮特凯恩群岛" },
    PR: { en: "Puerto Rico", zh: "波多黎各" },
    PS: { en: "Palestine", zh: "巴勒斯坦" },
    PT: { en: "Portugal", zh: "葡萄牙" },
    PW: { en: "Palau", zh: "帕劳" },
    PY: { en: "Paraguay", zh: "巴拉圭" },
    QA: { en: "Qatar", zh: "卡塔尔" },
    RE: { en: "Réunion", zh: "留尼汪" },
    RO: { en: "Romania", zh: "罗马尼亚" },
    RS: { en: "Serbia", zh: "塞尔维亚" },
    RU: { en: "Russia", zh: "俄罗斯" },
    RW: { en: "Rwanda", zh: "卢旺达" },
    SA: { en: "Saudi Arabia", zh: "沙特阿拉伯" },
    SB: { en: "Solomon Islands", zh: "所罗门群岛" },
    SC: { en: "Seychelles", zh: "塞舌尔" },
    SD: { en: "Sudan", zh: "苏丹" },
    SE: { en: "Sweden", zh: "瑞典" },
    SG: { en: "Singapore", zh: "新加坡" },
    SH: { en: "Saint Helena", zh: "圣赫勒拿" },
    SI: { en: "Slovenia", zh: "斯洛文尼亚" },
    SJ: { en: "Svalbard and Jan Mayen", zh: "斯瓦尔巴和扬马延" },
    SK: { en: "Slovakia", zh: "斯洛伐克" },
    SL: { en: "Sierra Leone", zh: "塞拉利昂" },
    SM: { en: "San Marino", zh: "圣马力诺" },
    SN: { en: "Senegal", zh: "塞内加尔" },
    SO: { en: "Somalia", zh: "索马里" },
    SR: { en: "Suriname", zh: "苏里南" },
    SS: { en: "South Sudan", zh: "南苏丹" },
    ST: { en: "São Tomé and Príncipe", zh: "圣多美和普林西比" },
    SV: { en: "El Salvador", zh: "萨尔瓦多" },
    SX: { en: "Sint Maarten", zh: "荷属圣马丁" },
    SY: { en: "Syria", zh: "叙利亚" },
    SZ: { en: "Eswatini", zh: "埃斯瓦蒂尼" },
    TC: { en: "Turks and Caicos Islands", zh: "特克斯和凯科斯群岛" },
    TD: { en: "Chad", zh: "乍得" },
    TF: { en: "French Southern Territories", zh: "法属南部领地" },
    TG: { en: "Togo", zh: "多哥" },
    TH: { en: "Thailand", zh: "泰国" },
    TJ: { en: "Tajikistan", zh: "塔吉克斯坦" },
    TK: { en: "Tokelau", zh: "托克劳" },
    TL: { en: "Timor-Leste", zh: "东帝汶" },
    TM: { en: "Turkmenistan", zh: "土库曼斯坦" },
    TN: { en: "Tunisia", zh: "突尼斯" },
    TO: { en: "Tonga", zh: "汤加" },
    TR: { en: "Türkiye", zh: "土耳其" },
    TT: { en: "Trinidad and Tobago", zh: "特立尼达和多巴哥" },
    TV: { en: "Tuvalu", zh: "图瓦卢" },
    TW: { en: "Taiwan", zh: "台湾" },
    TZ: { en: "Tanzania", zh: "坦桑尼亚" },
    UA: { en: "Ukraine", zh: "乌克兰" },
    UG: { en: "Uganda", zh: "乌干达" },
    UM: { en: "U.S. Minor Outlying Islands", zh: "美国本土外小岛屿" },
    US: { en: "United States", zh: "美国" },
    UY: { en: "Uruguay", zh: "乌拉圭" },
    UZ: { en: "Uzbekistan", zh: "乌兹别克斯坦" },
    VA: { en: "Holy See", zh: "梵蒂冈" },
    VC: { en: "Saint Vincent and the Grenadines", zh: "圣文森特和格林纳丁斯" },
    VE: { en: "Venezuela", zh: "委内瑞拉" },
    VG: { en: "British Virgin Islands", zh: "英属维尔京群岛" },
    VI: { en: "U.S. Virgin Islands", zh: "美属维尔京群岛" },
    VN: { en: "Vietnam", zh: "越南" },
    VU: { en: "Vanuatu", zh: "瓦努阿图" },
    WF: { en: "Wallis and Futuna", zh: "瓦利斯和富图纳" },
    WS: { en: "Samoa", zh: "萨摩亚" },
    YE: { en: "Yemen", zh: "也门" },
    YT: { en: "Mayotte", zh: "马约特" },
    ZA: { en: "South Africa", zh: "南非" },
    ZM: { en: "Zambia", zh: "赞比亚" },
    ZW: { en: "Zimbabwe", zh: "津巴布韦" },
};
/**
 * Look up a country / region by its ISO 3166-1 alpha-2 code.
 *
 * Returns null for an unknown or malformed code. Callers decide what to
 * show then — the raw code is still better than nothing, but the caller
 * should own that choice, not this function.
 *
 * The code is matched case-insensitively because data sources are
 * inconsistent about it: DB-IP emits "HK", some APIs emit "hk", and a
 * stray lowercase would otherwise silently lose the name.
 */
function countryNamesFor(code) {
    if (!code)
        return null;
    const normalized = code.trim().toUpperCase();
    if (normalized.length !== 2)
        return null;
    return COUNTRY_NAMES[normalized] ?? null;
}
/**
 * The English name for a country code, or null when the code is unknown.
 *
 * This is what the JSON API returns: an API that answers `"name": null`
 * for every country has a field that carries no information.
 */
function englishCountryName(code) {
    return countryNamesFor(code)?.en ?? null;
}
/**
 * The Simplified Chinese name for a country code, or null when unknown.
 */
function chineseCountryName(code) {
    return countryNamesFor(code)?.zh ?? null;
}
/** Every known country code, for diagnostics and tests. */
function knownCountryCodes() {
    return Object.keys(COUNTRY_NAMES);
}
//# sourceMappingURL=country-names.js.map