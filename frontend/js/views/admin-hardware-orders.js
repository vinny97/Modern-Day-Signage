import { showToast } from '../components/toast.js';
import { esc, isPlatformAdmin } from '../utils.js';

const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' });
const API = (url, opts = {}) => fetch('/api' + url, { headers: headers(), ...opts });

// Mirror of services/hardwareOrders.js ORDER_STATUSES (kept in sync manually;
// the server is the source of truth and re-validates every update).
const STATUSES = ['paid', 'preparing', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'refunded'];
const STATUS_LABELS = {
  paid: 'Paid', preparing: 'Preparing', ready_to_ship: 'Ready to Ship', shipped: 'Shipped',
  delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded',
};

function money(pence, currency) {
  const symbol = (currency || 'gbp').toLowerCase() === 'gbp' ? '£' : '';
  return symbol + (Number(pence || 0) / 100).toFixed(2);
}

function date(ts) {
  return ts ? new Date(Number(ts) * 1000).toLocaleString() : '—';
}

function statusBadge(status) {
  const color = status === 'shipped' || status === 'delivered' ? 'var(--success)'
    : status === 'cancelled' || status === 'refunded' ? 'var(--danger)'
    : 'var(--accent)';
  return `<span style="background:var(--bg-primary);color:${color};padding:2px 10px;border-radius:10px;font-size:11px;font-weight:500">${STATUS_LABELS[status] || esc(status)}</span>`;
}

export async function render(container) {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  if (!isPlatformAdmin(user)) {
    container.innerHTML = `<div class="empty-state"><h3>Access denied</h3><p>You don't have permission to view this page.</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <div><h1>Hardware Orders</h1><div class="subtitle">ScreenFizz Player fulfilment</div></div>
      <a href="#/admin" class="btn btn-secondary">Back to Admin</a>
    </div>
    <div class="settings-section">
      <div id="ordersTable"><p style="color:var(--text-muted)">Loading…</p></div>
    </div>
    <div id="orderDetail"></div>
  `;

  loadOrders();
}

async function loadOrders() {
  const el = document.getElementById('ordersTable');
  if (!el) return;
  let orders;
  try {
    const res = await API('/hardware/orders');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load orders');
    orders = await res.json();
  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
    return;
  }
  if (!orders.length) {
    el.innerHTML = `<p style="color:var(--text-muted)">No hardware orders yet.</p>`;
    return;
  }
  el.innerHTML = `
    <div class="table-wrap">
    <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:640px">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="padding:8px;text-align:left;color:var(--text-muted)">Order</th>
        <th style="padding:8px;text-align:left;color:var(--text-muted)">Customer</th>
        <th style="padding:8px;text-align:left;color:var(--text-muted)">Status</th>
        <th style="padding:8px;text-align:right;color:var(--text-muted)">Total</th>
        <th style="padding:8px;text-align:left;color:var(--text-muted)">Created</th>
      </tr></thead>
      <tbody>
        ${orders.map(o => `
          <tr data-order="${esc(o.id)}" style="border-bottom:1px solid var(--border);cursor:pointer">
            <td style="padding:8px;font-weight:500">${esc(o.order_number || '—')}</td>
            <td style="padding:8px"><div>${esc(o.customer_name || '—')}</div><div style="font-size:11px;color:var(--text-muted)">${esc(o.customer_email || '')}</div></td>
            <td style="padding:8px">${statusBadge(o.status)}</td>
            <td style="padding:8px;text-align:right">${money(o.total, o.currency)}</td>
            <td style="padding:8px;font-size:11px;color:var(--text-muted)">${date(o.created_at)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
  `;
  el.querySelectorAll('[data-order]').forEach(row => {
    row.addEventListener('click', () => openOrder(row.dataset.order));
  });
}

async function openOrder(id) {
  const el = document.getElementById('orderDetail');
  if (!el) return;
  el.innerHTML = `<div class="settings-section"><p style="color:var(--text-muted)">Loading order…</p></div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  let o;
  try {
    const res = await API(`/hardware/orders/${id}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load order');
    o = await res.json();
  } catch (err) {
    el.innerHTML = `<div class="settings-section"><p style="color:var(--danger)">${esc(err.message)}</p></div>`;
    return;
  }

  const addr = [o.shipping_address_line1, o.shipping_address_line2, o.city, o.postcode, o.country]
    .filter(Boolean).map(esc).join('<br>');
  const refunded = o.status === 'refunded';

  el.innerHTML = `
    <div class="settings-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h3 style="margin:0">${esc(o.order_number || 'Order')} ${statusBadge(o.status)}</h3>
        <button class="btn btn-secondary btn-sm" id="closeDetail">Close</button>
      </div>

      <div class="info-grid">
        <div class="info-card">
          <div class="info-card-label">Customer</div>
          <div style="font-size:13px;line-height:1.6">
            ${esc(o.customer_name || '—')}<br>
            ${esc(o.customer_email || '')}<br>
            ${o.customer_phone ? esc(o.customer_phone) : ''}
            ${o.vat_number ? `<br><span style="color:var(--text-muted)">VAT: ${esc(o.vat_number)}</span>` : ''}
          </div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Shipping Address</div>
          <div style="font-size:13px;line-height:1.6">${addr || '—'}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Payment</div>
          <div style="font-size:13px;line-height:1.6">
            Subtotal: ${money(o.subtotal, o.currency)}<br>
            Tax: ${money(o.tax, o.currency)}<br>
            <strong>Total: ${money(o.total, o.currency)}</strong><br>
            <span style="font-size:11px;color:var(--text-muted)">${esc(o.stripe_payment_intent || 'no payment intent')}</span>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:640px;margin-top:16px">
        <div class="form-group">
          <label>Status</label>
          <select class="input" id="ordStatus">
            ${STATUSES.map(s => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Courier</label>
          <input type="text" class="input" id="ordCourier" placeholder="Royal Mail" value="${esc(o.courier || '')}">
        </div>
        <div class="form-group">
          <label>Tracking Number</label>
          <input type="text" class="input" id="ordTracking" placeholder="AB123456789GB" value="${esc(o.tracking_number || '')}">
        </div>
        <div class="form-group">
          <label>Notes</label>
          <input type="text" class="input" id="ordNotes" placeholder="Internal notes" value="${esc(o.notes || '')}">
        </div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
        <button class="btn btn-secondary btn-sm" id="markPreparing">Mark Preparing</button>
        <button class="btn btn-primary btn-sm" id="markShipped">Mark Shipped</button>
        <button class="btn btn-secondary btn-sm" id="saveOrder">Save Changes</button>
        <button class="btn btn-danger btn-sm" id="refundOrder" ${refunded ? 'disabled' : ''} style="margin-left:auto">${refunded ? 'Refunded' : 'Refund'}</button>
      </div>
    </div>
  `;

  document.getElementById('closeDetail').onclick = () => { el.innerHTML = ''; };

  const body = () => ({
    status: document.getElementById('ordStatus').value,
    courier: document.getElementById('ordCourier').value.trim(),
    tracking_number: document.getElementById('ordTracking').value.trim(),
    notes: document.getElementById('ordNotes').value.trim(),
  });

  async function update(payload, successMsg) {
    try {
      const res = await API(`/hardware/orders/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || 'Update failed', 'error'); return; }
      showToast(successMsg, 'success');
      loadOrders();
      openOrder(id);
    } catch (err) { showToast(err.message, 'error'); }
  }

  document.getElementById('saveOrder').onclick = () => update(body(), 'Order updated');

  document.getElementById('markPreparing').onclick = () => {
    const p = body(); p.status = 'preparing';
    document.getElementById('ordStatus').value = 'preparing';
    update(p, 'Marked as preparing');
  };

  document.getElementById('markShipped').onclick = () => {
    const p = body();
    if (!p.courier || !p.tracking_number) {
      showToast('Enter a courier and tracking number to mark as shipped', 'error');
      return;
    }
    p.status = 'shipped';
    document.getElementById('ordStatus').value = 'shipped';
    update(p, 'Marked as shipped — customer notified by email');
  };

  document.getElementById('refundOrder').onclick = async () => {
    const btn = document.getElementById('refundOrder');
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Confirm Refund';
      setTimeout(() => { btn.dataset.confirm = '0'; btn.textContent = 'Refund'; }, 3000);
      return;
    }
    try {
      const res = await API(`/hardware/orders/${id}/refund`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || 'Refund failed', 'error'); return; }
      showToast('Order refunded', 'success');
      loadOrders();
      openOrder(id);
    } catch (err) { showToast(err.message, 'error'); }
  };
}

export function cleanup() {}
