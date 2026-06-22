const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const EMAIL_ENV = [
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_FROM_NAME',
  'RESEND_DEV_RESTRICT_TO',
];
const originalFetch = global.fetch;

function loadEmail(overrides = {}) {
  for (const key of EMAIL_ENV) delete process.env[key];
  Object.assign(process.env, overrides);
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../services/email')];
  return require('../services/email');
}

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of EMAIL_ENV) delete process.env[key];
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../services/email')];
});

test('returns a safe fallback when Resend is not configured', async () => {
  global.fetch = async () => { throw new Error('fetch should not be called'); };
  const { sendEmail, isConfigured } = loadEmail();

  assert.equal(isConfigured(), false);
  assert.deepEqual(
    await sendEmail({ to: 'user@example.com', subject: 'Hello', text: 'Welcome' }),
    { sent: false, reason: 'not_configured' },
  );
});

test('posts the existing email contract to Resend', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'email_123' }) };
  };
  const { sendEmail, isConfigured } = loadEmail({
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'hello@screenfizz.com',
    RESEND_FROM_NAME: 'ScreenFizz',
  });

  assert.equal(isConfigured(), true);
  assert.deepEqual(
    await sendEmail({ to: 'user@example.com', subject: 'Alert', text: 'Display offline' }),
    { sent: true, id: 'email_123' },
  );
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer re_test');
  assert.deepEqual(JSON.parse(request.options.body), {
    from: 'ScreenFizz <hello@screenfizz.com>',
    to: ['user@example.com'],
    subject: '[ScreenTinker] Alert',
    html: '<pre style="font-family:sans-serif">Display offline</pre>',
    text: 'Display offline',
  });
});

test('preserves raw subjects, HTML, and per-message sender names', async () => {
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const { sendEmail } = loadEmail({
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'hello@screenfizz.com',
  });

  await sendEmail({
    to: 'user@example.com',
    subject: 'Welcome',
    text: 'Plain version',
    html: '<h1>Welcome</h1>',
    fromName: 'Dan at ScreenFizz',
    rawSubject: true,
  });
  assert.equal(payload.from, 'Dan at ScreenFizz <hello@screenfizz.com>');
  assert.equal(payload.subject, 'Welcome');
  assert.equal(payload.html, '<h1>Welcome</h1>');
  assert.equal(payload.text, 'Plain version');
});

test('returns Resend failures without throwing', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => '{"message":"domain is not verified"}',
  });
  const { sendEmail } = loadEmail({
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'hello@screenfizz.com',
  });

  const result = await sendEmail({ to: 'user@example.com', subject: 'Hello', text: 'Welcome' });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'resend_error');
  assert.match(result.error, /403.*domain is not verified/);
});

test('dev recipient restriction suppresses delivery before calling Resend', async () => {
  global.fetch = async () => { throw new Error('fetch should not be called'); };
  const { sendEmail } = loadEmail({
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'hello@screenfizz.com',
    RESEND_DEV_RESTRICT_TO: 'developer@example.com',
  });

  assert.deepEqual(
    await sendEmail({ to: 'customer@example.com', subject: 'Hello', text: 'Welcome' }),
    { sent: false, reason: 'dev_restricted' },
  );
});
