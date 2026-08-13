// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import { lastEtlRun } from '../../storage/mysql';

export default async function marketingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    return reply.view('marketing/home.hbs', {
      layout: 'layouts/public', title: '首页', req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  app.get('/about', async (req, reply) => {
    return reply.view('marketing/about.hbs', {
      layout: 'layouts/public', title: '关于', req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  app.get('/docs', async (req, reply) => {
    return reply.view('marketing/docs.hbs', {
      layout: 'layouts/public', title: 'API 文档', req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  app.get('/pricing', async (req, reply) => {
    return reply.view('marketing/pricing.hbs', {
      layout: 'layouts/public', title: '定价', req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  app.get('/status', async (req, reply) => {
    const lastRun = await lastEtlRun(app.pool);
    return reply.view('marketing/status.hbs', {
      layout: 'layouts/public', title: '状态', lastRun, req, viewBaseUrl: app.viewBaseUrl,
    });
  });
}
