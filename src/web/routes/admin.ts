// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import { listUsers, findUserById, setDisabled, markEmailVerified, deleteUser, updatePassword } from '../../storage/users';
import { hashPassword } from '../auth/password';
import { verifyCsrfRequest } from '../plugins/csrf';

// /admin/* is already gated by the auth guard in src/web/plugins/auth.ts:
// non-admins are 403-redirected before this handler runs, so req.user is
// guaranteed to be an admin here.
export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin', async (_req, reply) => reply.code(302).redirect('/admin/users'));

  app.get('/admin/users', async (req, reply) => {
    const q = req.query as { page?: string; q?: string; role?: 'user' | 'admin' };
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const { rows, total } = await listUsers(app.pool, { offset, limit, search: q.q, role: q.role });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const queryParts: string[] = [];
    if (q.q) queryParts.push(`q=${encodeURIComponent(q.q)}`);
    if (q.role) queryParts.push(`role=${encodeURIComponent(q.role)}`);
    const queryString = queryParts.join('&');
    return reply.view('admin/users.hbs', {
      layout: 'layouts/admin', title: req.t('admin.users.title'),
      users: rows, page, totalPages, q: q.q ?? '', role: q.role ?? '', queryString, req,
    });
  });

  app.get<{ Params: { id: string } }>('/admin/users/:id', async (req, reply) => {
    const u = await findUserById(app.pool, Number(req.params.id));
    if (!u) return reply.code(404).view('errors/404.hbs', { layout: 'layouts/public', title: req.t('error.404.title'), req });
    return reply.view('admin/user-detail.hbs', { layout: 'layouts/admin', title: u.email, user: u, req });
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/enable', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    await setDisabled(app.pool, Number(req.params.id), false);
    return reply.redirect('/admin/users/' + req.params.id);
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/disable', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    await setDisabled(app.pool, Number(req.params.id), true);
    return reply.redirect('/admin/users/' + req.params.id);
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/verify-email', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    await markEmailVerified(app.pool, Number(req.params.id));
    return reply.redirect('/admin/users/' + req.params.id);
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/reset-password', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    const tempPassword = `Temp${Math.random().toString(36).slice(2, 10)}1`;
    await updatePassword(app.pool, Number(req.params.id), await hashPassword(tempPassword));
    return reply.redirect('/admin/users/' + req.params.id);
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/delete', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    await deleteUser(app.pool, Number(req.params.id));
    return reply.redirect('/admin/users');
  });
}
