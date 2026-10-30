import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../public/api.js';

let calls;
const respond = (status, body) => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) };
  };
};
beforeEach(() => { calls = []; api.onUnauthorized = null; });

test('post sends JSON with method and content type', async () => {
  respond(200, { id: 'x' });
  assert.deepEqual(await api.post('/api/admin/employees', { name: 'A' }), { id: 'x' });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, '{"name":"A"}');
  assert.equal(calls[0].init.credentials, 'same-origin');
});

test('body-less mutations still send the JSON content type', async () => {
  respond(200, { ok: true });
  await api.del('/api/admin/shifts/1');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('errors become ApiError', async () => {
  respond(422, { error: 'x', remaining: 3 });
  await assert.rejects(api.put('/api/admin/settings', {}), e => e instanceof ApiError && e.status === 422 && e.message === 'x' && e.data.remaining === 3);
});

test('401 on admin calls triggers onUnauthorized', async () => {
  let hit = 0;
  api.onUnauthorized = () => hit++;
  respond(401, { error: 'expired' });
  await assert.rejects(api.get('/api/admin/state'));
  await assert.rejects(api.post('/api/auth/login', { pin: '1' }));     // a wrong PIN is not a session expiry
  assert.equal(hit, 1);
});

test('file downloads return blob + filename, and errors stay JSON errors', async () => {
  globalThis.fetch = async () => ({ status: 200, ok: true, blob: async () => 'BLOB',
    headers: { get: h => h === 'content-disposition' ? 'attachment; filename="payroll_2026-10-26.xlsx"' : null } });
  assert.deepEqual(await api.file('/api/admin/export/payroll.xlsx'), { blob: 'BLOB', name: 'payroll_2026-10-26.xlsx' });
  let hit = 0;
  api.onUnauthorized = () => hit++;
  respond(401, { error: 'expired' });
  await assert.rejects(api.file('/api/admin/export/payroll.pdf'), e => e instanceof ApiError && e.status === 401);
  assert.equal(hit, 1);
});

test('204 resolves null', async () => {
  respond(204, null);
  assert.equal(await api.get('/x'), null);
});
