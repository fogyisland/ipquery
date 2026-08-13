// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildServer } from '../../src/api/server';
import { loadConfig } from '../../src/config';

describe('health route', () => {
  it('GET /healthz returns 200 with status ok', async () => {
    const cfg = loadConfig();
    cfg.api.port = 0;
    const app = await buildServer(cfg);
    try {
      const res = await request(app.server).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });
});