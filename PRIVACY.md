# Privacy Policy

Last updated: 2026-08-19

IPQuery is self-hosted software. **This repository does not collect, transmit,
or share any data with the IPQuery authors.** All data handling described
below happens on infrastructure you control.

## 1. Data You Collect on Your Instance

When you operate your own IPQuery instance, the following data is stored in
your MySQL database:

| Category        | What                                                                          | Purpose                    | Retention                                             |
| --------------- | ----------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------- |
| Account         | Email, display name, hashed password (Argon2id)                               | Authentication             | Until you delete the account                          |
| Sessions        | Session ID, IP, user agent, expiry                                            | Persisted login            | 7 days rolling (configurable via `SESSION_TTL_HOURS`) |
| API keys        | Label, prefix, hashed secret, last-used timestamp                             | Authenticated API access   | Until revoked                                         |
| Query log       | Source IP, timestamp, status (hit/miss/invalid), user/API key (if applicable) | Analytics, troubleshooting | Until you delete it                                   |
| Admin audit log | Admin user, action, target, IP, timestamp                                     | Compliance                 | Until you delete it                                   |
| ETL runs        | Source, status, merge counts, timestamps                                      | Operational history        | Until you delete it                                   |

You, as the operator, are the data controller for this data. You are
responsible for posting your own privacy notice to your end users and
complying with applicable data-protection laws (GDPR, CCPA, etc.).

## 2. Data the Service Sends Outbound

- **MaxMind** — When you configure `MAXMIND_LICENSE_KEY`, the ETL pipeline
  authenticates to MaxMind's download endpoint to fetch the GeoLite2
  datasets. Your license key is sent to MaxMind. The downloaded files are
  stored locally under `DATA_DIR`. We do not proxy this traffic.
- **DB-IP** — Free CSV files are downloaded from db-ip.com's published URLs.
- **ip2region** — Bundled with the upstream library; no outbound call.
- **SMTP** — If you configure `SMTP_*`, transactional emails (signup
  verification, password reset) are sent through your SMTP relay.

No telemetry, analytics, or crash reporting is sent anywhere by default.

## 3. Cookies

IPQuery sets the following cookies on your users' browsers:

| Cookie | Purpose                                    | HttpOnly | SameSite |
| ------ | ------------------------------------------ | -------- | -------- |
| `sid`  | Session identifier                         | yes      | Lax      |
| `csrf` | Double-submit CSRF token                   | no       | Lax      |
| `lang` | UI language preference (`zh-CN` / `en-US`) | no       | Lax      |

## 4. Subprocessors

None. The Service does not call any third-party service on your behalf
except the data-source downloads and the SMTP relay you configure yourself.

## 5. Data Subject Requests

If you receive a data-subject access request (DSAR) from one of your users,
you must fulfill it from your own database. A reasonable starting point is
to delete the corresponding row in the `users` table; cascade rules will
remove the dependent sessions and API keys.

## 6. Changes

This document will be updated if the runtime data-handling behavior changes
in a user-visible way. Changes will be noted in `CHANGELOG.md`.

## 7. Contact

Questions about this policy: open an issue at the project repository.
