// Request size limits: tiny for public kiosk/auth endpoints, large (after sign-in) for admin backups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeTestApp, loginAgent, fixture } from './helpers.js';

test('kiosk rejects bodies over 16 KB', async () => {
  const { app } = await makeTestApp();
  const r = await request(app).post('/api/kiosk/identify').send({ pin: '1111', pad: 'x'.repeat(20000) });
  assert.equal(r.status, 413);
});

test('unauthenticated admin POST is 401 without reading a big body', async () => {
  const { app } = await makeTestApp();
  const r = await request(app).post('/api/admin/import').send({ pad: 'x'.repeat(100000) });
  assert.equal(r.status, 401);
});

test('admin import accepts an 11 MB backup', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app);
  const b = fixture('backup-v2');
  b.audit = [...(b.audit || []), { ts: 1, actor: 'Admin', action: 'Big', detail: 'x'.repeat(11 * 1024 * 1024) }];
  const r = await a.post('/api/admin/import').send(b);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
