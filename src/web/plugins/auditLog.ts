// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { recordAuditLog } from '../../storage/auditLog';

declare module 'fastify' {
  interface FastifyRequest {
    auditAction?: {
      action: string;
      targetType?: string;
      targetId?: number | string;
      metadata?: Record<string, unknown>;
    };
  }
}

export function registerAuditLog(app: FastifyInstance): void {
  app.decorateRequest('auditAction', null as unknown as NonNullable<FastifyRequest['auditAction']>);

  app.addHook('onResponse', async (req, reply) => {
    const audit = req.auditAction;
    if (!audit) return;
    if (reply.statusCode >= 400) return;
    const user = (req as FastifyRequest & { user?: { id: number; email: string } | null }).user ?? null;
    try {
      await recordAuditLog(app.pool, {
        actor: user ? { id: user.id, email: user.email } : null,
        action: audit.action,
        targetType: audit.targetType,
        targetId: audit.targetId,
        metadata: audit.metadata ?? null,
        ip: req.ip,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        statusCode: reply.statusCode,
      });
    } catch (err) {
      app.log.error({ err }, 'audit log write failed');
    }
  });
}
