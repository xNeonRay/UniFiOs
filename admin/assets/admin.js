/**
 * UniFi Captive Portal — Admin Panel JS
 */
'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────
const API_BASE = '../api';

// API key stored in sessionStorage (cleared on tab/browser close)
// Falls back to a prompt on each session for security
let apiKey = sessionStorage.getItem('admin_api_key') || '';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const qs  = (sel, ctx = document) => ctx.querySelector(sel);
const qsa = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const show = el => el && el.classList.remove('hidden');
const hide = el => el && el.classList.add('hidden');

/** Escape HTML to prevent XSS when building table rows */
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function apiFetch(path, { method = 'GET', body } = {}) {
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key':    apiKey,
        },
    };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(API_BASE + path, opts);
    const json = await res.json().catch(() => ({ success: false, error: 'Invalid response' }));
    return { ok: res.ok, status: res.status, ...json };
}

let toastTimer;
function toast(msg, type = 'info') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className   = 'toast';
    if (type === 'error') el.style.background = '#dc2626';
    else                  el.style.background = '#1e293b';
    show(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(el), 3500);
}

function badge(text, type) {
    return `<span class="badge badge-${type}">${text}</span>`;
}

function fmtDate(str) {
    if (!str) return '—';
    return new Date(str.replace(' ', 'T')).toLocaleString();
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => toast('Copiado al portapapeles'));
}

// ─── API key gate ─────────────────────────────────────────────────────────────
function checkApiKey() {
    if (!apiKey) {
        show(document.getElementById('apiKeyPrompt'));
    }
}

document.getElementById('apiKeySubmit').addEventListener('click', () => {
    const val = document.getElementById('apiKeyInput').value.trim();
    if (!val) { toast('Ingresa tu API key', 'error'); return; }
    apiKey = val;
    sessionStorage.setItem('admin_api_key', apiKey);
    hide(document.getElementById('apiKeyPrompt'));
    initAll();
});

document.getElementById('apiKeyInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('apiKeySubmit').click();
});

// ─── Tab navigation ───────────────────────────────────────────────────────────
qsa('.nav-item').forEach(el => {
    el.addEventListener('click', e => {
        e.preventDefault();
        const tab = el.dataset.tab;
        qsa('.nav-item').forEach(n => n.classList.remove('active'));
        el.classList.add('active');
        qsa('.tab-content').forEach(t => t.classList.remove('active'));
        document.getElementById('tab-' + tab).classList.add('active');
        loaders[tab] && loaders[tab]();
    });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function loadDashboard() {
    const [vRes, uRes, dRes] = await Promise.all([
        apiFetch('/vouchers?active=1'),
        apiFetch('/users'),
        apiFetch('/devices'),
    ]);

    document.getElementById('statVouchers').textContent = vRes.data?.length ?? '—';
    document.getElementById('statUsers').textContent    = uRes.data?.length ?? '—';
    document.getElementById('statDevices').textContent  = dRes.data?.length ?? '—';

    // Usages today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const usgRes = await apiFetch('/vouchers');
    if (usgRes.data) {
        const today = usgRes.data.reduce((sum, v) => sum + (v.redemption_count ?? 0), 0);
        document.getElementById('statUsages').textContent = today;
    }

    document.getElementById('apiStatus').textContent = '✅ API conectada';
}

// ─── Vouchers ─────────────────────────────────────────────────────────────────
async function loadVouchers() {
    const site   = document.getElementById('v_filter_site').value;
    const active = document.getElementById('v_filter_active').value;

    let qs = [];
    if (site)   qs.push('site=' + encodeURIComponent(site));
    if (active !== '') qs.push('active=' + active);

    const res = await apiFetch('/vouchers' + (qs.length ? '?' + qs.join('&') : ''));
    const tbody = document.getElementById('vouchersTbody');

    if (!res.success || !res.data?.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="loading-row">No hay vouchers.</td></tr>';
        return;
    }

    tbody.innerHTML = res.data.map(v => `
        <tr>
            <td class="mono" style="cursor:pointer" title="Click para copiar"
                data-copy="${escHtml(v.code)}">
                ${escHtml(v.code)} 📋
            </td>
            <td>${escHtml(v.site_id || '—')}</td>
            <td>${v.ssid ? escHtml(v.ssid) : badge('Cualquiera', 'gray')}</td>
            <td>${escHtml(v.duration_minutes)} min</td>
            <td>${escHtml(v.used_count)} / ${escHtml(v.max_uses)}</td>
            <td>${v.is_active ? badge('Activo', 'green') : badge('Inactivo', 'red')}</td>
            <td>${fmtDate(v.created_at)}</td>
            <td>
                <button class="btn btn-danger btn-sm"
                        data-action="delete-voucher"
                        data-id="${escHtml(v.id)}"
                        data-code="${escHtml(v.code)}">Eliminar</button>
            </td>
        </tr>
    `).join('');
}

document.getElementById('refreshVouchers').addEventListener('click', loadVouchers);
document.getElementById('v_filter_site').addEventListener('change', loadVouchers);
document.getElementById('v_filter_active').addEventListener('change', loadVouchers);

// Event delegation for voucher table actions
document.getElementById('vouchersTbody').addEventListener('click', async e => {
    const copyTarget = e.target.closest('[data-copy]');
    if (copyTarget) { copyToClipboard(copyTarget.dataset.copy); return; }

    const delBtn = e.target.closest('[data-action="delete-voucher"]');
    if (delBtn) {
        const { id, code } = delBtn.dataset;
        if (!confirm(`¿Eliminar voucher ${code}?`)) return;
        const r = await apiFetch('/vouchers/' + encodeURIComponent(id), { method: 'DELETE' });
        if (r.success) { toast('Voucher eliminado'); loadVouchers(); }
        else           { toast(r.error || 'Error al eliminar', 'error'); }
    }
});

// Create voucher
document.getElementById('openCreateVoucher').addEventListener('click', () => {
    document.getElementById('createVoucherForm').classList.toggle('hidden');
});
document.getElementById('cancelCreateVoucher').addEventListener('click', () => {
    hide(document.getElementById('createVoucherForm'));
});

document.getElementById('submitCreateVoucher').addEventListener('click', async () => {
    const btn  = document.getElementById('submitCreateVoucher');
    const res  = document.getElementById('createVoucherResult');
    const ssid = document.getElementById('v_ssid').value.trim();

    btn.disabled   = true;
    btn.textContent = 'Creando…';
    hide(res);

    const payload = {
        count:            parseInt(document.getElementById('v_count').value) || 1,
        duration_minutes: parseInt(document.getElementById('v_duration').value) || 480,
        max_uses:         parseInt(document.getElementById('v_maxuses').value) || 1,
        site:             document.getElementById('v_site').value.trim() || 'default',
        ssid:             ssid || null,
        note:             document.getElementById('v_note').value.trim(),
        sync_unifi:       document.getElementById('v_sync').checked,
    };

    const quota = parseInt(document.getElementById('v_quota').value);
    if (quota > 0) payload.quota_mb = quota;

    const r = await apiFetch('/vouchers', { method: 'POST', body: payload });

    btn.disabled   = false;
    btn.textContent = 'Crear';
    show(res);

    if (r.success) {
        const codes = r.data.map(v => v.code).join(', ');
        res.className = 'result-box success';
        res.textContent = `✓ ${r.data.length} voucher(s) creados: ${codes}` +
                          (r.synced_unifi ? ' (sincronizado con UniFi)' : ' (local, sin UniFi sync)');
        loadVouchers();
    } else {
        res.className = 'result-box error';
        res.textContent = '✗ ' + (r.error || 'Error desconocido');
    }
});


// ─── Users ────────────────────────────────────────────────────────────────────
async function loadUsers() {
    const q   = document.getElementById('u_search').value;
    const res = await apiFetch('/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const tbody = document.getElementById('usersTbody');

    if (!res.success || !res.data?.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="loading-row">No hay usuarios.</td></tr>';
        return;
    }

    tbody.innerHTML = res.data.map(u => `
        <tr>
            <td>${escHtml(u.id)}</td>
            <td>${escHtml(u.name)}</td>
            <td>${escHtml(u.email || '—')}</td>
            <td>${escHtml(u.phone || '—')}</td>
            <td>${escHtml(u.device_count ?? 0)}</td>
            <td>${fmtDate(u.created_at)}</td>
            <td>
                <button class="btn btn-danger btn-sm"
                        data-action="delete-user"
                        data-id="${escHtml(u.id)}"
                        data-name="${escHtml(u.name)}">Eliminar</button>
            </td>
        </tr>
    `).join('');
}

document.getElementById('refreshUsers').addEventListener('click', loadUsers);
document.getElementById('u_search').addEventListener('input', debounce(loadUsers, 400));

// Event delegation for users table
document.getElementById('usersTbody').addEventListener('click', async e => {
    const delBtn = e.target.closest('[data-action="delete-user"]');
    if (delBtn) {
        const { id, name } = delBtn.dataset;
        if (!confirm(`¿Eliminar usuario "${name}"?`)) return;
        const r = await apiFetch('/users/' + encodeURIComponent(id), { method: 'DELETE' });
        if (r.success) { toast('Usuario eliminado'); loadUsers(); }
        else           { toast(r.error || 'Error', 'error'); }
    }
});

document.getElementById('openCreateUser').addEventListener('click', () => {
    document.getElementById('createUserForm').classList.toggle('hidden');
});
document.getElementById('cancelCreateUser').addEventListener('click', () => {
    hide(document.getElementById('createUserForm'));
});

document.getElementById('submitCreateUser').addEventListener('click', async () => {
    const name  = document.getElementById('u_name').value.trim();
    const email = document.getElementById('u_email').value.trim();
    const phone = document.getElementById('u_phone').value.trim();
    if (!name) { toast('El nombre es requerido', 'error'); return; }

    const r = await apiFetch('/users', { method: 'POST', body: { name, email, phone } });
    if (r.success) {
        toast('Usuario creado');
        hide(document.getElementById('createUserForm'));
        loadUsers();
    } else {
        toast(r.error || 'Error al crear usuario', 'error');
    }
});


// ─── Devices ──────────────────────────────────────────────────────────────────
async function loadDevices() {
    const q   = document.getElementById('d_search').value;
    const res = await apiFetch('/devices' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const tbody = document.getElementById('devicesTbody');

    if (!res.success || !res.data?.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="loading-row">No hay dispositivos.</td></tr>';
        return;
    }

    tbody.innerHTML = res.data.map(d => `
        <tr>
            <td class="mono">${escHtml(d.mac_address)}</td>
            <td>${escHtml(d.hostname || '—')}</td>
            <td>${d.user_name ? escHtml(d.user_name) : badge('Sin asignar', 'gray')}</td>
            <td>${fmtDate(d.last_seen)}</td>
            <td>${fmtDate(d.created_at)}</td>
            <td>
                <button class="btn btn-danger btn-sm"
                        data-action="unauthorize-device"
                        data-mac="${escHtml(d.mac_address)}">Desautorizar</button>
            </td>
        </tr>
    `).join('');
}

document.getElementById('refreshDevices').addEventListener('click', loadDevices);
document.getElementById('d_search').addEventListener('input', debounce(loadDevices, 400));

// Event delegation for devices table
document.getElementById('devicesTbody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action="unauthorize-device"]');
    if (btn) {
        const mac = btn.dataset.mac;
        if (!confirm(`¿Desautorizar ${mac} de UniFi?`)) return;
        const r = await apiFetch('/devices/unauthorize', { method: 'POST', body: { mac } });
        if (r.success) { toast('Dispositivo desautorizado'); }
        else           { toast(r.error || 'Error', 'error'); }
    }
});

// ─── Usages ───────────────────────────────────────────────────────────────────
async function loadUsages() {
    // Fetch vouchers with usage data
    const res   = await apiFetch('/vouchers');
    const tbody = document.getElementById('usagesTbody');

    if (!res.success || !res.data?.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="loading-row">No hay registros.</td></tr>';
        return;
    }

    // Flatten usage-like info from vouchers
    const rows = res.data.filter(v => v.redemption_count > 0).map(v => `
        <tr>
            <td class="mono">—</td>
            <td class="mono">${escHtml(v.code)}</td>
            <td>${escHtml(v.ssid || '—')}</td>
            <td>${escHtml(v.site_id)}</td>
            <td>${fmtDate(v.created_at)}</td>
            <td>${v.expires_at ? fmtDate(v.expires_at) : '—'}</td>
        </tr>
    `).join('');

    tbody.innerHTML = rows || '<tr><td colspan="6" class="loading-row">No hay usos registrados.</td></tr>';
}

document.getElementById('refreshUsages').addEventListener('click', loadUsages);

// ─── Modal ────────────────────────────────────────────────────────────────────
document.getElementById('modalClose').addEventListener('click', () => {
    hide(document.getElementById('modal'));
});

// ─── Loader registry ─────────────────────────────────────────────────────────
const loaders = {
    dashboard: loadDashboard,
    vouchers:  loadVouchers,
    users:     loadUsers,
    devices:   loadDevices,
    usages:    loadUsages,
};

// ─── Debounce ─────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function initAll() {
    loadDashboard();
}

checkApiKey();
if (apiKey) initAll();
