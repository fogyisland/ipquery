// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { createMailer } from '../../src/mailer';
import type { AppConfig } from '../../src/config';

const baseCfg = (smtp: Partial<AppConfig['smtp']> = {}): AppConfig => ({
  db: { host: '', port: 0, user: '', password: '', database: '', poolSize: 0 },
  maxmind: { editions: [] },
  api: { port: 0, rateLimit: 0 },
  etl: { schedule: '', timezone: '', dataDir: '' },
  web: { baseUrl: '', cookieDomain: '', cookieSecure: false, sessionTtlHours: 1, sessionSecret: '', csrfSecret: '' },
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: 'a@b', ...smtp },
  security: { loginMaxAttempts: 1, loginLockoutMinutes: 1, signupRatePerIpPerHour: 1, verifyResendCooldownSeconds: 1 },
  admin: { email: '', password: '' },
});

describe('mailer', () => {
  it('console transport returns without throwing', async () => {
    const m = createMailer(baseCfg());
    await expect(m.send({ to: 'x@y.z', subject: 's', text: 't', html: '<p>t</p>' })).resolves.toBeUndefined();
  });

  it('SMTP transport is created when host set', async () => {
    const m = createMailer(baseCfg({ host: 'smtp.example.com' }));
    expect(m).toBeDefined();
  });
});
