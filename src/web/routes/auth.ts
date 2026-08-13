// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import * as Handlebars from 'handlebars';
import { createUser, findUserByEmail, findUserById, markEmailVerified } from '../../storage/users';
import { createVerification, findVerificationByHash, consumeVerification, lastVerificationForUser } from '../../storage/tokens';
import { hashPassword } from '../auth/password';
import { generateToken, hashToken } from '../auth/tokens';
import { verifyCsrfRequest } from '../plugins/csrf';
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
}
