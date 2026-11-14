// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { t } from "../../src/web/i18n";
import zhCN from "../../src/web/i18n/zh-CN.json";
import enUS from "../../src/web/i18n/en-US.json";

describe("web i18n t()", () => {
  it("returns Chinese value for known key", () => {
    // assume zh-CN.json has key "common.signup" with value "注册"
    expect(t("zh-CN", "common.signup")).toBe("注册");
  });

  it("returns English value when both locales have the key", () => {
    expect(t("en-US", "common.signup")).toBe("Sign up");
  });

  it("falls back to Chinese when locale missing the key", () => {
    // 'dashboard.keys.copy' is intentionally absent from en-US.json so the
    // fallback branch in t() is exercised by this test.
    expect(t("en-US", "dashboard.keys.copy")).toBe("复制");
  });

  it("returns key itself when key missing everywhere", () => {
    expect(t("zh-CN", "nonexistent.key")).toBe("nonexistent.key");
  });

  it("resolves admin user status labels without shadowing the column title", () => {
    // The status pills and the table header both live under
    // `admin.users.status*`. If the labels are nested at exactly
    // `admin.users.status`, t() returns the object, sees a non-string,
    // and falls back to printing the literal key as the column title.
    expect(t("zh-CN", "admin.users.status")).toBe("状态");
    expect(t("zh-CN", "admin.users.statusLabels.statusDisabled")).toBe("已停用");
    expect(t("zh-CN", "admin.users.statusLabels.statusVerified")).toBe("已验证");
    expect(t("zh-CN", "admin.users.statusLabels.statusUnverified")).toBe("未验证");

    expect(t("en-US", "admin.users.status")).toBe("Status");
    expect(t("en-US", "admin.users.statusLabels.statusDisabled")).toBe("Disabled");
    expect(t("en-US", "admin.users.statusLabels.statusVerified")).toBe("Verified");
    expect(t("en-US", "admin.users.statusLabels.statusUnverified")).toBe("Unverified");
  });

  it("interpolates {var} placeholders", () => {
    // zh-CN.json: "greeting.hello": "你好,{name}"
    expect(t("zh-CN", "greeting.hello", { name: "张三" })).toBe("你好,张三");
  });

  it("interpolates multiple variables", () => {
    // zh-CN.json: "lookup.found": "{ip} 位于 {country}"
    expect(t("zh-CN", "lookup.found", { ip: "8.8.8.8", country: "美国" })).toBe("8.8.8.8 位于 美国");
  });

  it("has no double-brace placeholders in any dictionary string", () => {
    // The translator substitutes SINGLE braces: it splits on "{name}" and
    // rejoins. A string written as "{{name}}" therefore renders as
    // "{value}" — a stray brace wrapped around the substituted value,
    // which looks like a bug in the message rather than in the template.
    //
    // Every dictionary entry is checked, because a template that is
    // wrong in one place is wrong in every place it is used, and the
    // individual interpolation tests above only cover the keys they
    // happen to name.
    const offenders: string[] = [];

    const walk = (node: unknown, trail: string): void => {
      if (typeof node === "string") {
        // "{{" only ever appears as a placeholder here; these files hold
        // plain text, not Handlebars.
        if (node.includes("{{")) offenders.push(`${trail}: ${node}`);
        return;
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          walk(value, trail ? `${trail}.${key}` : key);
        }
      }
    };

    for (const [locale, dict] of Object.entries({ "zh-CN": zhCN, "en-US": enUS })) {
      walk(dict, locale);
    }

    expect(offenders).toEqual([]);
  });

  it("substitutes the reason into the setup failure message", () => {
    // The wizard shows the driver's reason verbatim, so a template
    // mistake here is visible to every operator who mistypes a
    // connection — it is not a cosmetic string.
    const zh = t("zh-CN", "setup.database.failureReason", {
      reason: "the server refused the connection",
    });
    expect(zh).toContain("the server refused the connection");
    expect(zh).not.toContain("{reason}");
    expect(zh).not.toContain("{the server refused");
    expect(zh).not.toContain("{{");

    const en = t("en-US", "setup.database.failureReason", {
      reason: "the server refused the connection",
    });
    expect(en).toContain("the server refused the connection");
    expect(en).not.toContain("{reason}");
    expect(en).not.toContain("{{");
  });
});
