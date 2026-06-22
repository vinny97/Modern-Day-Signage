const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontendDir = path.join(__dirname, '..', '..', 'frontend');

test('every Start Self-Service CTA enters the registration flow', () => {
  const pages = fs.readdirSync(frontendDir).filter(file => file.endsWith('.html'));
  const ctas = [];

  for (const page of pages) {
    const html = fs.readFileSync(path.join(frontendDir, page), 'utf8');
    const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>\s*Start Self-Service\s*<\/a>/gi;
    for (const match of html.matchAll(pattern)) ctas.push({ page, href: match[1] });
  }

  assert.ok(ctas.length > 0, 'expected at least one Start Self-Service CTA');
  assert.deepEqual(
    ctas.filter(cta => cta.href !== '/signup'),
    [],
    `misdirected Start Self-Service CTA: ${JSON.stringify(ctas)}`,
  );
});

test('core Self-Service marketing pages state the 7-day no-card trial', () => {
  for (const page of ['landing.html', 'pricing.html', 'self-service-software.html']) {
    const html = fs.readFileSync(path.join(frontendDir, page), 'utf8');
    assert.match(html, /7-day free trial/i, `${page} should mention the 7-day free trial`);
    assert.match(html, /no credit card required/i, `${page} should state that no credit card is required`);
  }
});
