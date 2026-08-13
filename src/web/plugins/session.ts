// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadSession } from '../../storage/sessions';
import { findUserById } from '../../storage/users';
import type { Session, User } from '../../types';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
    user: User | null;
  }
}

export async function registerSession(app: FastifyInstance): Promise<void> {
  app.decorateRequest('session', null as Session | null);
  app.decorateRequest('user', null as User | null);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const sid = req.cookies?.sid;
    if (!sid) return;
    const session = await loadSession(app.pool, sid);
    if (!session) return;
    req.session = session;
    const user = await findUserById(app.pool, session.userId);
    req.user = user;
  });
}