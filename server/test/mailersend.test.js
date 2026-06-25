const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const MAILERSEND_ENV = [
  'MAILERSEND_API_KEY',
  'MAILERSEND_FROM_EMAIL',
  'MAILERSEND_FROM_NAME',
];
const originalFetch = global.fetch;

function loadMailerSend(overrides = {}) {
  for (const key of MAILERSEND_ENV) delete process.env[key];
  Object.assign(process.env, overrides);
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../services/mailersend')];
  return require('../services/mailersend');
}

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of MAILERSEND_ENV) delete process.env[key];
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../services/mailersend')];
});

test('returns a safe fallback when MailerSend is not configured', async () => {
  global.fetch = async () => { throw new Error('fetch should not be called'); };
  const { sendMailerSend, isConfigured } = loadMailerSend({
    MAILERSEND_FROM_EMAIL: '',
  });

  assert.equal(isConfigured(), false);
  assert.deepEqual(
    await sendMailerSend({
      to: 'customer@example.com',
      subject: 'Thanks',
      html: '<p>Hello</p>',
    }),
    { sent: false, reason: 'not_configured' },
  );
});

test('posts the confirmation email contract to MailerSend', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 202, text: async () => '' };
  };
  const { sendMailerSend, isConfigured } = loadMailerSend({
    MAILERSEND_API_KEY: 'ms_test',
    MAILERSEND_FROM_EMAIL: 'info@screenfizz.com',
    MAILERSEND_FROM_NAME: 'ScreenFizz',
  });

  assert.equal(isConfigured(), true);
  assert.deepEqual(
    await sendMailerSend({
      to: 'customer@example.com',
      toName: 'Customer Name',
      subject: 'We received your enquiry',
      html: '<p>Hello</p>',
      text: 'Hello',
    }),
    { sent: true },
  );
  assert.equal(request.url, 'https://api.mailersend.com/v1/email');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer ms_test');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), {
    from: { email: 'info@screenfizz.com', name: 'ScreenFizz' },
    to: [{ email: 'customer@example.com', name: 'Customer Name' }],
    subject: 'We received your enquiry',
    html: '<p>Hello</p>',
    text: 'Hello',
  });
});

test('returns MailerSend failures without throwing', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 422,
    text: async () => '{"message":"The from.email must be a verified email address."}',
  });
  const { sendMailerSend } = loadMailerSend({
    MAILERSEND_API_KEY: 'ms_test',
    MAILERSEND_FROM_EMAIL: 'info@screenfizz.com',
  });

  const result = await sendMailerSend({
    to: 'customer@example.com',
    subject: 'Thanks',
    html: '<p>Hello</p>',
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'mailersend_error');
  assert.match(result.error, /422.*verified email address/);
});
