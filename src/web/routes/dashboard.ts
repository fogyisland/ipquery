// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import { countQueriesByStatusSince, listQueryLogs } from '../../storage/queryLog';
import { createApiKey, listApiKeysForUser, revokeApiKey, findApiKeyById } from '../../storage/apiKeys';
import { updateDisplayName, updateEmail, updatePassword, getUserPasswordHash } from '../../storage/users';
import { generateApiKey, hashToken } from '../auth/tokens';
import { hashPassword, verifyPassword, validatePassword } from '../auth/password';
import { verifyCsrfRequest } from '../plugins/csrf';

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // /dashboard/* is already gated by the auth guard in src/web/plugins/auth.ts:
  // unauthenticated requests are redirected to /login?next=... before this
  // handler runs, so req.user is guaranteed non-null here.
  app.get('/dashboard', async (req, reply) => {
    const counts = await countQueriesByStatusSince(app.pool, new Date(Date.now() - 7 * 86400_000));
    return reply.view('dashboard/index.hbs', { layout: 'layouts/dashboard', title: req.t('dashboard.title'), counts, req });
  });

  app.get('/dashboard/history', async (req, reply) => {
    const q = req.query as { page?: string; status?: 'hit' | 'miss' | 'invalid' };
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const { rows, total } = await listQueryLogs(app.pool, {
      offset, limit, userId: req.user!.id, status: q.status,
    });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const queryParts: string[] = [];
    if (q.status) queryParts.push(`status=${encodeURIComponent(q.status)}`);
    const queryString = queryParts.join('&');
    return reply.view('dashboard/history.hbs', {
      layout: 'layouts/dashboard', title: req.t('dashboard.history.title'),
      rows, page, totalPages, status: q.status ?? '', queryString, req,
    });
  });

  app.get('/dashboard/keys', async (req, reply) => {
    const keys = await listApiKeysForUser(app.pool, req.user!.id);
    return reply.view('dashboard/keys.hbs', {
      layout: 'layouts/dashboard', title: req.t('dashboard.keys.title'), keys, req,
    });
  });

  app.post('/dashboard/keys', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    const label = ((req.body as { label?: string }).label ?? '').trim();
    if (!label || label.length > 64) {
      const keys = await listApiKeysForUser(app.pool, req.user!.id);
      return reply.code(400).view('dashboard/keys.hbs', {
        layout: 'layouts/dashboard', title: req.t('dashboard.keys.title'),
        flash: { error: 'invalid label' }, keys, req,
      });
    }
    const plaintext = generateApiKey();
    const keyHash = hashToken(plaintext);
    const keyPrefix = plaintext.slice(0, 8);
    await createApiKey(app.pool, req.user!.id, label, keyHash, keyPrefix);
    const keys = await listApiKeysForUser(app.pool, req.user!.id);
    return reply.view('dashboard/keys.hbs', {
      layout: 'layouts/dashboard', title: req.t('dashboard.keys.title'),
      newKeyPlain: plaintext, keys, req,
    });
  });

  app.post<{ Params: { id: string } }>('/dashboard/keys/:id/revoke', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(404).view('errors/404.hbs', { layout: 'layouts/public', title: req.t('error.404.title'), req });
    }
    const key = await findApiKeyById(app.pool, id);
    if (!key || key.userId !== req.user!.id) {
      return reply.code(404).view('errors/404.hbs', { layout: 'layouts/public', title: req.t('error.404.title'), req });
    }
    await revokeApiKey(app.pool, id);
    return reply.code(302).redirect('/dashboard/keys');
  });

  app.get<{ Params: { id: string } }>('/dashboard/keys/:id/revoke/confirm', async (req, reply) => {
    const id = Number(req.params.id);
    const key = await findApiKeyById(app.pool, id);
    if (!key || key.userId !== req.user!.id) {
      return reply.code(404).view('errors/404.hbs', { layout: 'layouts/public', title: req.t('error.404.title'), req });
    }
    return reply.view('dashboard/key-revoke-confirm.hbs', {
      layout: 'layouts/dashboard', title: req.t('dashboard.keys.revoke.confirm.title'), key, req,
    });
  });

  app.get('/dashboard/profile', async (req, reply) => {
    // req.user is guaranteed non-null: registerAuthGuards already 302-redirects
    // unauthenticated requests for /dashboard/* paths before this handler runs.
    return reply.view('dashboard/profile.hbs', { layout: 'layouts/dashboard', title: req.t('dashboard.profile.title'), req });
  });

  app.post('/dashboard/profile', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    const body = req.body as { action?: string; displayName?: string; email?: string; oldPassword?: string; newPassword?: string };
    const action = body.action ?? '';

    if (action === 'displayName') {
      const dn = (body.displayName ?? '').trim();
      if (!dn || dn.length > 64) {
        return reply.code(400).view('dashboard/profile.hbs', {
          layout: 'layouts/dashboard', title: req.t('dashboard.profile.title'),
          flash: { error: 'invalid display_name' }, req,
        });
      }
      await updateDisplayName(app.pool, req.user!.id, dn);
      return reply.view('dashboard/profile.hbs', {
        layout: 'layouts/dashboard', title: req.t('dashboard.profile.title'),
        flash: { success: req.t('dashboard.profile.saved') }, req,
      });
    }
    if (action === 'email') {
      const email = (body.email ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply.code(400).view('dashboard/profile.hbs', {
          layout: 'layouts/dashboard', title: req.t('dashboard.profile.title'),
          flash: { error: 'invalid email' }, req,
        });
      }
      await updateEmail(app.pool, req.user!.id, email);
      // email_verified is reset by updateEmail; re-verify by admin or via verification flow (out of scope here)
      // For simplicity in MVP, we just save the new email. Production: trigger re-verification.
      return reply.view('dashboard/profile.hbs', {
        layout: 'layouts/dashboard', title: req.t('dashboard.profile.title'),
        flash: { success: req.t('dashboard.profile.saved') }, req,
      });
    }
    if (action === 'password') {
      const old = body.oldPassword ?? '';
      const newPw = body.newPassword ?? '';
      const v = validatePassword(newPw);
      if (!v.ok) return reply.code(400).view('dashboard/profile.hbs', {
        layout: 'layouts/dashboard', title: req.t('dashboard.profile.title'),
        flash: { error: req.t('auth.signup.error.password_weak') }, req,
      });
      const hash = await getUserPasswordHash(app.pool, req.user!.id);
      if (!hash || !await verifyPassword(hash, old)) return reply.code(401).view('dashboard/profile.hbs', {
        layout: 'layouts/dashboard', title: req.t('dashboard.profile.title'),
        flash: { error: 'old_password_incorrect' }, req,
      });
      await updatePassword(app.pool, req.user!.id, await hashPassword(newPw));
      return reply.view('dashboard/profile.hbs', {
        layout: 'layouts/dashboard', title: req.t('dashboard.profile.title'),
        flash: { success: req.t('dashboard.profile.saved') }, req,
      });
    }
    return reply.code(400).view('dashboard/profile.hbs', {
      layout: 'layouts/dashboard', title: req.t('dashboard.profile.title'),
      flash: { error: 'unknown action' }, req,
    });
  });
}
