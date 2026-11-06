# Security Policy

## Supported Versions

Only the latest minor release receives security fixes. Older versions are
not patched.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |
| < 0.1   | no        |

## Reporting a Vulnerability

Please **do not** open a public issue for suspected vulnerabilities.

Report privately by emailing **security@example.com** (PGP key on request).
Include:

- A description of the issue and its impact.
- A reproducer (curl transcript, test, or proof-of-concept).
- The commit hash or release tag you tested against.
- Your name / handle if you would like to be credited in the CHANGELOG.

We aim to acknowledge new reports within **3 business days** and to issue
a fix or mitigation within **30 days** for confirmed issues, depending on
severity and complexity.

## Scope

In scope:

- Authentication, authorization, and session handling.
- CSRF, CORS, and rate-limit logic.
- SQL injection, XSS, command injection, SSRF, path traversal.
- Secret redaction in logs and admin UIs.
- Dependency vulnerabilities with a working exploit.

Out of scope:

- The accuracy of geolocation data.
- The compliance posture of upstream data sources (MaxMind, DB-IP).
- Denial-of-service against the upstream data download endpoints.

## Severity Classification

We use CVSS v3.1 as a starting reference. Final severity is set by the
maintainers after a triage call.

## Disclosure Policy

We follow a coordinated-disclosure model. Once a fix is released, we
publish a CHANGELOG entry and a `SECURITY.md` advisory crediting the
reporter. Please give us a reasonable window before public disclosure.
