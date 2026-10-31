// Brevo-only mailer (plan Tasks 29–30). Tests never touch the network: fetch is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailer } from '../src/mail.js';
import { makeTestApp, loginAgent, fixture } from './helpers.js';

const ENV = { BREVO_API_KEY: 'xkeysib-secret', MAIL_FROM: 'payroll@shop.com', MAIL_FROM_NAME: 'GJ06 Payroll', MAIL_REPLY_TO: 'owner@gmail.com' };
const brevo = (calls, { status = 201, body = { messageId: '<m1@brevo>' }, fail } = {}) => async (url, init) => {
  calls.push({ url, init, body: JSON.parse(init.body) });
  if(fail) throw fail;
  return new Response(JSON.stringify(body), { status });
};
const pdf = Buffer.from('%PDF-1.7 fake');

test('not configured without BREVO_API_KEY and MAIL_FROM', async () => {
  const m = createMailer({});
  assert.equal(m.configured, false);
  await assert.rejects(m.send({ to: 'a@b.co', subject: 's', text: 't' }), e => e.status === 503 && /BREVO_API_KEY/.test(e.message));
});

test('send posts the Brevo JSON with a base64 PDF attachment', async () => {
  const calls = [];
  const m = createMailer(ENV, { fetch: brevo(calls) });
  const r = await m.send({ to: 'ann@x.co', toName: 'Ann', subject: 'Payslip', text: 'Hi Ann', attachments: [{ name: 'payslip.pdf', content: pdf }] });
  assert.equal(r.messageId, '<m1@brevo>');
  const c = calls[0];
  assert.equal(c.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['api-key'], 'xkeysib-secret');
  assert.ok(c.init.signal);
  assert.deepEqual(c.body.sender, { email: 'payroll@shop.com', name: 'GJ06 Payroll' });
  assert.deepEqual(c.body.to, [{ email: 'ann@x.co', name: 'Ann' }]);
  assert.deepEqual(c.body.replyTo, { email: 'owner@gmail.com' });
  assert.ok(c.body.htmlContent.includes('Hi Ann'));
  assert.equal(c.body.textContent, 'Hi Ann');
  assert.equal(c.body.attachment[0].name, 'payslip.pdf');
  assert.equal(Buffer.from(c.body.attachment[0].content, 'base64').subarray(0, 4).toString(), '%PDF');
});

test('errors carry Brevo\'s message or a short reason, never the key', async () => {
  const bad = createMailer(ENV, { fetch: brevo([], { status: 401, body: { code: 'unauthorized', message: 'Key not found' } }) });
  await assert.rejects(bad.send({ to: 'a@b.co', subject: 's', text: 't' }), e => /Key not found/.test(e.message) && !e.message.includes('xkeysib'));
  const down = createMailer(ENV, { fetch: brevo([], { fail: new TypeError('fetch failed') }) });
  await assert.rejects(down.send({ to: 'a@b.co', subject: 's', text: 't' }), /could not reach/i);
  const slow = createMailer(ENV, { fetch: brevo([], { fail: Object.assign(new Error('x'), { name: 'TimeoutError' }) }) });
  await assert.rejects(slow.send({ to: 'a@b.co', subject: 's', text: 't' }), /timed out/i);
});

const withMail = async (fetchImpl = brevo([])) => {
  const x = await makeTestApp({ mailer: createMailer(ENV, { fetch: fetchImpl }) });
  const a = await loginAgent(x.app);
  await a.post('/api/admin/import').send(fixture('backup-v2'));
  const s = (await a.get('/api/admin/state')).body;
  for(const [id, email] of [['e1', 'alice@x.co'], ['e2', 'bob@x.co']]){
    const e = s.employees.find(x => x.id === id);
    await a.put(`/api/admin/employees/${id}`).send({ ...e, email });
  }
  return { ...x, a: await loginAgent(x.app, '4321'), a0: a };
};

test('email one payslip: PDF attached, audited with messageId; status endpoint reports it', async () => {
  const calls = [];
  const { a } = await withMail(brevo(calls));
  const r = await a.post('/api/admin/payslips/email').send({ week: '2026-10-26', emp: 'e1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map(x => [x.name, x.status]), [['Alice Smith', 'sent']]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.to[0].email, 'alice@x.co');
  assert.match(calls[0].body.subject, /payslip 2026-10-26/i);
  assert.match((await a.get('/api/admin/audit?q=email payslip')).body[0].detail, /Alice Smith · 2026-10-26 · sent <m1@brevo>/);
  const status = (await a.get('/api/admin/payslips/email-status?week=2026-10-26')).body;
  assert.equal(typeof status.lastSent, 'number');
});

test('email all: skips staff without email, keeps going after a failure', async () => {
  let n = 0;
  const { a } = await withMail(async () => (++n === 1 ? new Response('{"message":"Invalid email"}', { status: 400 }) : new Response('{"messageId":"ok"}', { status: 201 })));
  const r = await a.post('/api/admin/payslips/email').send({ week: '2026-10-26', emp: 'all' });
  const byName = Object.fromEntries(r.body.results.map(x => [x.name, x]));
  assert.equal(byName['Alice Smith'].status, 'failed');
  assert.match(byName['Alice Smith'].error, /Invalid email/);
  assert.equal(byName['Bob Jones'].status, 'sent');
  assert.equal(byName['Cara Old'].status, 'skipped');
});

test('503 when email is not set up; 409 while an email-all for that week is running; 401 without session', async () => {
  const plain = await makeTestApp();
  const pa = await loginAgent(plain.app);
  assert.equal((await pa.post('/api/admin/payslips/email').send({ week: '2026-10-26', emp: 'all' })).status, 503);
  let release;
  const gate = new Promise(r => { release = r; });
  const { a, app } = await withMail(async () => { await gate; return new Response('{"messageId":"x"}', { status: 201 }); });
  const first = a.post('/api/admin/payslips/email').send({ week: '2026-10-26', emp: 'all' }).then(r => r);
  await new Promise(r => setTimeout(r, 50));
  const second = await a.post('/api/admin/payslips/email').send({ week: '2026-10-26', emp: 'all' });
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
  const { default: request } = await import('supertest');
  assert.equal((await request(app).post('/api/admin/payslips/email').send({ week: '2026-10-26' })).status, 401);
});

test('email all skips staff with no pay that week', async () => {
  const calls = [];
  const { a } = await withMail(brevo(calls));
  await a.post('/api/admin/employees').send({ name: 'Dan', pin: '7777', rate1: 20, email: 'dan@x.co' });
  const r = await a.post('/api/admin/payslips/email').send({ week: '2026-10-26', emp: 'all' });
  const dan = r.body.results.find(x => x.name === 'Dan');
  assert.deepEqual([dan.status, dan.error], ['skipped', 'No pay this week']);
  assert.ok(!calls.some(c => c.body.to?.[0]?.email === 'dan@x.co'));
});
