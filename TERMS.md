# Terms of Service

Last updated: 2026-08-19

These Terms of Service ("Terms") govern your use of the IPQuery geolocation
service ("Service"). By running, deploying, or using the Service, you agree
to be bound by these Terms.

If you are accepting these Terms on behalf of an organization, you represent
that you have authority to bind that organization, and "you" refers to that
organization.

## 1. The Service

IPQuery is an HTTP API that maps IP addresses to geographic and network
metadata by aggregating three datasets: MaxMind GeoLite2, ip2region, and DB-IP.
The Service is provided as self-hosted software under the MIT License
(see `LICENSE`). You are responsible for operating your own instance.

## 2. Data Sources

The Service integrates data from third-party providers. Each provider has its
own license terms that you must comply with:

- **MaxMind GeoLite2** — GeoLite2 EULA. Requires a registered MaxMind license
  key. Do not redistribute the data files.
- **DB-IP** — CC BY 4.0. You must display the attribution
  "IP Geolocation by DB-IP" in any user-visible interface.
- **ip2region** — Apache 2.0. Attribution preserved in `NOTICE`.

IPQuery is not affiliated with these providers. You are solely responsible
for accepting and complying with each source's terms.

## 3. Accuracy Disclaimer

Geolocation data is inherently approximate. The Service is provided
"AS IS" without warranty of accuracy, completeness, or fitness for any
particular purpose. Do not use the Service for legal, financial, or
safety-critical decisions without independent verification.

## 4. Acceptable Use

You agree not to:

- Use the Service to violate any applicable law or third-party right.
- Reverse-engineer or attempt to extract the upstream data files from
  the database to redistribute them.
- Use the Service to build a competing data redistribution product.
- Probe, scan, or load-test the Service in ways that degrade its
  availability for other users of your instance.

## 5. Accounts

Administrators are responsible for all activity under their credentials.
You agree to use a strong password, keep credentials confidential, and
promptly revoke any API key that may have been exposed.

## 6. Termination

You may stop using the Service at any time by shutting down your instance.
We reserve the right to discontinue distribution of new releases; existing
instances and prior versions continue to operate under these Terms.

## 7. Limitation of Liability

To the maximum extent permitted by applicable law, the authors and
contributors of IPQuery shall not be liable for any indirect, incidental,
special, consequential, or punitive damages, or any loss of data, profits,
or business, arising from or in connection with the Service.

## 8. Changes

These Terms may be updated. Material changes will be noted in `CHANGELOG.md`.
Continued use after a change constitutes acceptance.

## 9. Contact

Questions about these Terms: open an issue at the project repository.
