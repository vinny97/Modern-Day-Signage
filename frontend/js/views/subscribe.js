import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';

function getCurrentUser() {
  try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }
}

function stateHeading(access) {
  if (!access) return 'Subscribe to ScreenFizz Self Service';
  switch (access.state) {
    case 'trial':    return `Your trial ends in ${access.trial_days_remaining} day${access.trial_days_remaining === 1 ? '' : 's'}`;
    case 'expired':  return 'Your trial has ended';
    case 'past_due': return 'Your payment failed';
    case 'cancelled': return 'Your subscription has ended';
    default:         return 'Subscribe to ScreenFizz Self Service';
  }
}

function stateBody(access) {
  if (!access) return 'Get remote management, 1 screen, and 2 GB storage.';
  switch (access.state) {
    case 'trial':
      return 'Subscribe now to keep your screen running after the trial. No commitment - cancel any time.';
    case 'expired':
      return 'Your screen is currently paused. Subscribe to restore it instantly - your content and settings are all still here.';
    case 'past_due':
      return 'We could not process your last payment. Update your payment method to restore access.';
    case 'cancelled':
      return 'Your subscription has ended. Subscribe again to resume your screen.';
    default:
      return 'Get remote management, 1 screen, and 2 GB storage.';
  }
}

let _checkoutInFlight = false;

export async function render(container) {
  const user = getCurrentUser();
  const access = user?.access;

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:60vh;padding:24px">
      <div style="max-width:420px;width:100%;text-align:center">
        <div style="font-size:48px;margin-bottom:16px">&#128187;</div>
        <h1 style="font-size:24px;font-weight:700;margin:0 0 8px">${stateHeading(access)}</h1>
        <p style="color:var(--text-secondary);margin:0 0 32px;line-height:1.5">${stateBody(access)}</p>

        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;margin-bottom:24px;text-align:left">
          <div style="font-size:18px;font-weight:700;margin-bottom:4px">Self Service</div>
          <div style="font-size:32px;font-weight:700;color:var(--accent);margin-bottom:16px">
            £5 <span style="font-size:14px;color:var(--text-secondary);font-weight:400">/month</span>
          </div>
          <ul style="list-style:none;padding:0;margin:0;font-size:14px;color:var(--text-secondary)">
            <li style="padding:4px 0">&#10003;&nbsp; 1 screen</li>
            <li style="padding:4px 0">&#10003;&nbsp; 2 GB storage</li>
            <li style="padding:4px 0">&#10003;&nbsp; Unlimited playlists</li>
            <li style="padding:4px 0">&#10003;&nbsp; Remote management</li>
            <li style="padding:4px 0">&#10003;&nbsp; Cancel any time</li>
          </ul>
        </div>

        <button id="subscribeBtn" class="btn btn-primary" style="width:100%;padding:14px;font-size:16px;font-weight:600">
          Subscribe - £5/month
        </button>

        ${access?.state === 'trial' ? `
        <p style="margin-top:12px;font-size:12px;color:var(--text-muted)">
          You can continue using your trial until it expires.
          <a href="#/" style="color:var(--accent)">Back to dashboard</a>
        </p>` : `
        <p style="margin-top:12px;font-size:12px;color:var(--text-muted)">
          <a href="#/" style="color:var(--accent)">Back to dashboard</a>
        </p>`}
      </div>
    </div>
  `;

  document.getElementById('subscribeBtn')?.addEventListener('click', async () => {
    if (_checkoutInFlight) return;
    _checkoutInFlight = true;
    const btn = document.getElementById('subscribeBtn');
    if (btn) btn.textContent = 'Loading...';
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ plan_id: 'starter', interval: 'monthly' }),
      });
      const data = await res.json();
      if (data.error) { showToast(data.error, 'error'); }
      else if (data.url) { window.location.href = data.url; }
    } catch (err) {
      showToast(err.message || t('common.error'), 'error');
    } finally {
      _checkoutInFlight = false;
      const b = document.getElementById('subscribeBtn');
      if (b) b.textContent = 'Subscribe - £5/month';
    }
  });
}

export function cleanup() {
  _checkoutInFlight = false;
}
