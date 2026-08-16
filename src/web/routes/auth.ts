// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import * as Handlebars from 'handlebars';
import { createUser, findUserByEmail, findUserById, markEmailVerified, setLastLogin, getUserPasswordHash } from '../../storage/users';
import { createVerification, findVerificationByHash, consumeVerification, lastVerificationForUser } from '../../storage/tokens';
import { hashPassword, verifyPassword } from '../auth/password';
import { generateToken, hashToken } from '../auth/tokens';
import { verifyCsrfRequest } from '../plugins/csrf';
import { setSessionCookie, clearSessionCookie } from '../plugins/auth';
import { recordLoginFailure, recordLoginSuccess, isLocked } from '../plugins/loginRateLimit';
import { createSession, destroySession } from '../../storage/sessions';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const EMAIL_TEMPLATES_DIR = path.join(__dirname, '..', 'emails');

let verifyEmailTemplate: Handlebars.TemplateDelegate | null = null;
async function getVerifyEmailTpl(): Promise<Handlebars.TemplateDelegate> {
  if (verifyEmailTemplate) return verifyEmailTemplate;
  const src = await fs.readFile(path.join(EMAIL_TEMPLATES_DIR, 'verify-email.hbs'), 'utf8');
  verifyEmailTemplate = Handlebars.compile(src);
  return verifyEmailTemplate;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // GET /signup
  app.get('/signup', async (req, reply) => {
    return reply.view('auth/signup.hbs', { layout: 'layouts/auth', title: req.t('auth.signup.title'), req });
  });

  // POST /signup
  app.post('/signup', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    const body = req.body as { email?: string; password?: string; displayName?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    const displayName = (body.displayName ?? '').trim();

    const error = (msg: string) => reply.code(400).view('auth/signup.hbs', {
      layout: 'layouts/auth', title: req.t('auth.signup.title'), error: msg, req,
    });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(req.t('auth.signup.error.email_format'));
    if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return error(req.t('auth.signup.error.password_weak'));
    // FIX (Task 14): brief line 103 incorrectly returned email_format for displayName error
    if (displayName.length === 0 || displayName.length > 64) return error(req.t('auth.signup.error.displayName_invalid'));
    if (await findUserByEmail(app.pool, email)) return reply.code(409).view('auth/signup.hbs', {
      layout: 'layouts/auth', title: req.t('auth.signup.title'), error: req.t('auth.signup.error.duplicate'), req,
    });

    const passwordHash = await hashPassword(password);
    const user = await createUser(app.pool, { email, passwordHash, displayName });

    // admin bootstrap: only when users table was empty
    const [rows] = await app.pool.query<import('mysql2').RowDataPacket[]>('SELECT COUNT(*) AS c FROM users');
    if (Number((rows as Record<string, unknown>[])[0]?.c) === 1 && app.cfg.admin.email && app.cfg.admin.password && app.cfg.admin.email === email) {
      await app.pool.query(`UPDATE users SET role = 'admin' WHERE id = ?`, [user.id]);
    }

    // send verification email
    const token = generateToken();
    const tokenHash = hashToken(token);
    await createVerification(app.pool, user.id, tokenHash, new Date(Date.now() + 86_400_000));
    const verifyUrl = `${app.cfg.web.baseUrl}/verify?token=${encodeURIComponent(token)}`;
    const html = await (await getVerifyEmailTpl())({ verifyUrl });
    await app.mailer.send({
      to: email, subject: 'IPQuery 邮箱验证', text: `请访问以下链接验证邮箱:\n${verifyUrl}`, html,
    });

    return reply.code(200).view('auth/signup-success.hbs', {
      layout: 'layouts/auth', title: req.t('auth.signup.success.title'),
      message: req.t('auth.signup.success.body'), req,
    });
  });

  // GET /verify
  app.get('/verify', async (req, reply) => {
    const token = (req.query as { token?: string }).token ?? '';
    if (!token) return reply.code(401).view('auth/verify-result.hbs', {
      layout: 'layouts/auth', title: req.t('verify.title'), success: false, message: req.t('verify.invalid'), reason: 'invalid', req,
    });
    const tokenHash = hashToken(token);
    const v = await findVerificationByHash(app.pool, tokenHash);
    if (!v) return reply.code(401).view('auth/verify-result.hbs', {
      layout: 'layouts/auth', title: req.t('verify.title'), success: false, message: req.t('verify.invalid'), reason: 'invalid', req,
    });
    if (v.consumedAt) return reply.code(410).view('auth/verify-result.hbs', {
      layout: 'layouts/auth', title: req.t('verify.title'), success: false, message: req.t('verify.consumed'), reason: 'consumed', req,
    });
    if (v.expiresAt.getTime() < Date.now()) return reply.code(410).view('auth/verify-result.hbs', {
      layout: 'layouts/auth', title: req.t('verify.title'), success: false, message: req.t('verify.expired'), reason: 'expired', req,
    });
    await markEmailVerified(app.pool, v.userId);
    await consumeVerification(app.pool, v.id);
    return reply.code(302).redirect('/login?verified=1');
  });

  // POST /verify/resend
  app.post<{ Params: { userId: string } }>('/verify/resend/:userId', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    const userId = Number(req.params.userId);
    const last = await lastVerificationForUser(app.pool, userId);
    if (last && last.createdAt.getTime() + app.cfg.security.verifyResendCooldownSeconds * 1000 > Date.now()) {
      return reply.code(429).redirect('/login?cooldown=1');
    }
    const u = await findUserById(app.pool, userId);
    if (!u) return reply.code(404).redirect('/login');
    const token = generateToken();
    const tokenHash = hashToken(token);
    await createVerification(app.pool, userId, tokenHash, new Date(Date.now() + 86_400_000));
    const verifyUrl = `${app.cfg.web.baseUrl}/verify?token=${encodeURIComponent(token)}`;
    const html = await (await getVerifyEmailTpl())({ verifyUrl });
    await app.mailer.send({
      to: u.email, subject: 'IPQuery 邮箱验证', text: `请访问以下链接验证邮箱:\n${verifyUrl}`, html,
    });
    return reply.code(302).redirect('/login?resent=1');
  });

  // GET /login
  app.get('/login', async (req, reply) => {
    const q = req.query as { next?: string; verified?: string; disabled?: string; verify_required?: string; userId?: string };
    const viewData: Record<string, unknown> = { req };
    let notice: { success?: string; error?: string; info?: string } = {};
    if (q.verified) notice.success = req.t('verify.success');
    if (q.disabled) notice.error = req.t('auth.login.error.disabled');
    if (q.verify_required) notice.info = req.t('auth.verify.required');
    viewData.flash = notice;
    if (q.verify_required && q.userId) {
      viewData.verifyRequired = true;
      viewData.verifyUserId = q.userId;
    }
    return reply.view('auth/login.hbs', {
      layout: 'layouts/auth', title: req.t('auth.login.title'), ...viewData,
    });
  });

  // POST /login
  app.post('/login', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    const body = req.body as { email?: string; password?: string; next?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';

    const lock = isLocked(email);
    if (lock.locked) {
      return reply.code(429).view('auth/login.hbs', {
        layout: 'layouts/auth', title: req.t('auth.login.title'),
        error: req.t('auth.login.error.locked', { minutes: Math.ceil(lock.retryAfterSec / 60) }),
        req,
      });
    }

    const user = await findUserByEmail(app.pool, email);
    if (!user) {
      recordLoginFailure(email, app.cfg.security.loginMaxAttempts, app.cfg.security.loginLockoutMinutes);
      return reply.code(401).view('auth/login.hbs', {
        layout: 'layouts/auth', title: req.t('auth.login.title'),
        error: req.t('auth.login.error.credentials'), email, req,
      });
    }

    const hash = await getUserPasswordHash(app.pool, user.id);
    const ok = hash ? await verifyPassword(hash, password) : false;
    if (!ok) {
      recordLoginFailure(email, app.cfg.security.loginMaxAttempts, app.cfg.security.loginLockoutMinutes);
      return reply.code(401).view('auth/login.hbs', {
        layout: 'layouts/auth', title: req.t('auth.login.title'),
        error: req.t('auth.login.error.credentials'), email, req,
      });
    }

    if (!user.emailVerified) {
      return reply.code(302).redirect(`/login?verify_required=1&userId=${user.id}`);
    }
    if (user.isDisabled) {
      return reply.code(302).redirect('/login?disabled=1');
    }

    recordLoginSuccess(email);
    const sid = generateToken(16);
    const expiresAt = new Date(Date.now() + app.cfg.web.sessionTtlHours * 3600_000);
    await createSession(app.pool, sid, user.id, expiresAt);
    await setLastLogin(app.pool, user.id);
    await setSessionCookie(reply, sid, app.cfg.web.sessionTtlHours * 3600, app.cfg.web.cookieSecure, app.cfg.web.cookieDomain);

    const next = (body.next && body.next.startsWith('/')) ? body.next : '/dashboard';
    return reply.code(302).redirect(next);
  });

  // POST /logout
  app.post('/logout', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    if (req.session) await destroySession(app.pool, req.session.id);
    await clearSessionCookie(reply, app.cfg.web.cookieDomain);
    return reply.code(302).redirect('/');
  });
}
