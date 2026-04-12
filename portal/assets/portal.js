/**
 * UniFi Captive Portal — portal.js
 * Handles voucher redemption flow + chatbot widget
 */
'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────
const CFG = window.PORTAL_CONFIG || {};
const API  = CFG.apiBase || '/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const qs = (sel, ctx = document) => ctx.querySelector(sel);
const show = el => el && el.classList.remove('hidden');
const hide = el => el && el.classList.add('hidden');

function showStep(id) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
}

async function apiPost(path, data) {
    const res = await fetch(API + path, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data),
    });
    const json = await res.json().catch(() => ({ success: false, error: 'Invalid server response' }));
    return { ok: res.ok, status: res.status, ...json };
}

async function apiGet(path) {
    const res  = await fetch(API + path);
    const json = await res.json().catch(() => ({ success: false, error: 'Invalid response' }));
    return { ok: res.ok, status: res.status, ...json };
}

// ─── Voucher form ─────────────────────────────────────────────────────────────
const voucherForm   = document.getElementById('voucherForm');
const voucherInput  = document.getElementById('voucherCode');
const voucherError  = document.getElementById('voucherError');
const redeemBtn     = document.getElementById('redeemBtn');
const progressFill  = document.getElementById('progressFill');
const connectingMsg = document.getElementById('connectingMsg');

// Auto-insert hyphen after 5 chars
voucherInput && voucherInput.addEventListener('input', e => {
    let v = e.target.value.replace(/[^A-Z0-9a-z]/g, '').toUpperCase();
    if (v.length > 5) v = v.slice(0, 5) + '-' + v.slice(5, 10);
    e.target.value = v;
});

function setLoading(loading) {
    const text    = qs('.btn-text', redeemBtn);
    const spinner = qs('.btn-spinner', redeemBtn);
    redeemBtn.disabled = loading;
    if (loading) { hide(text); show(spinner); }
    else         { show(text); hide(spinner); }
}

function showError(msg) {
    voucherError.textContent = msg;
    voucherError.classList.remove('hidden');
}

function clearError() {
    voucherError.classList.add('hidden');
    voucherError.textContent = '';
}

function animateProgress(targetPct, duration = 800) {
    return new Promise(resolve => {
        const start   = parseFloat(progressFill.style.width || '0');
        const diff    = targetPct - start;
        const startTs = performance.now();
        const tick = ts => {
            const elapsed = ts - startTs;
            const pct = Math.min(start + diff * (elapsed / duration), targetPct);
            progressFill.style.width = pct + '%';
            if (elapsed < duration) requestAnimationFrame(tick);
            else resolve();
        };
        requestAnimationFrame(tick);
    });
}

// Poll for actual internet access (client-side check after server confirms authorization)
async function pollVerify(mac, site, maxAttempts = 3, delayMs = 4000) {
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, delayMs));
        try {
            const res = await apiGet(`/verify/${encodeURIComponent(mac)}?site=${encodeURIComponent(site)}`);
            if (res.authorized) return true;
        } catch (_) { /* ignore */ }
    }
    return false;
}

voucherForm && voucherForm.addEventListener('submit', async e => {
    e.preventDefault();
    clearError();

    const code = voucherInput.value.trim().toUpperCase();
    if (!code || code.length < 11) {
        showError('Por favor ingresa un código válido (XXXXX-XXXXX).');
        return;
    }

    setLoading(true);
    showStep('stepConnecting');
    progressFill.style.width = '0%';

    try {
        connectingMsg.textContent = 'Validando voucher…';
        await animateProgress(30);

        const res = await apiPost('/vouchers/redeem', {
            code: code,
            mac:  CFG.clientMac,
            ssid: CFG.ssid,
            site: CFG.site,
        });

        if (!res.success) {
            showStep('stepVoucher');
            setLoading(false);
            showError(res.error || 'Error al canjear el voucher.');
            return;
        }

        connectingMsg.textContent = 'Autorizando dispositivo…';
        await animateProgress(65);

        // Verify internet access with polling
        connectingMsg.textContent = 'Verificando conexión a internet…';
        let hasInternet = res.internet_access;

        if (!hasInternet && CFG.clientMac) {
            hasInternet = await pollVerify(CFG.clientMac, CFG.site);
        }

        await animateProgress(100);

        // Show success
        const successMsg  = document.getElementById('successMsg');
        const expiresInfo = document.getElementById('expiresInfo');
        const continueBtn = document.getElementById('continueBtn');

        if (hasInternet) {
            successMsg.textContent = '¡Tu dispositivo ya tiene acceso a internet!';
        } else {
            successMsg.textContent = 'Conexión procesada. Si no tienes internet en 10 segundos, ' +
                                     'reconecta al WiFi.';
        }

        if (res.expires_at) {
            const d = new Date(res.expires_at.replace(' ', 'T'));
            expiresInfo.textContent = 'Sesión válida hasta: ' + d.toLocaleString();
        }

        continueBtn.href = CFG.redirectUrl || 'https://google.com';
        showStep('stepSuccess');

    } catch (err) {
        const errMsg = document.getElementById('errorMsg');
        errMsg.textContent = 'Error de conexión. Por favor verifica tu red e intenta de nuevo.';
        showStep('stepError');
    } finally {
        setLoading(false);
    }
});

// Retry button
document.getElementById('retryBtn') && document.getElementById('retryBtn').addEventListener('click', () => {
    showStep('stepVoucher');
    voucherInput.value = '';
    clearError();
});

// ─── Chat Widget ──────────────────────────────────────────────────────────────
const chatToggle   = document.getElementById('chatToggle');
const chatWindow   = document.getElementById('chatWindow');
const chatClose    = document.getElementById('chatClose');
const chatMessages = document.getElementById('chatMessages');
const chatInput    = document.getElementById('chatInput');
const chatSend     = document.getElementById('chatSend');
const chatBadge    = document.getElementById('chatBadge');

let chatSessionId = localStorage.getItem('chat_session_id') || null;
let chatOpen      = false;

// Open chat via footer/alt-action links
['openChatLink', 'openChatFooter'].forEach(id => {
    const el = document.getElementById(id);
    el && el.addEventListener('click', e => { e.preventDefault(); openChat(); });
});

function openChat() {
    chatOpen = true;
    chatWindow.classList.remove('hidden');
    chatWindow.setAttribute('aria-hidden', 'false');
    hide(chatBadge);
    chatInput.focus();
    scrollChatToBottom();
}

function closeChat() {
    chatOpen = false;
    chatWindow.classList.add('hidden');
    chatWindow.setAttribute('aria-hidden', 'true');
}

chatToggle && chatToggle.addEventListener('click', () => {
    chatOpen ? closeChat() : openChat();
});

chatClose && chatClose.addEventListener('click', closeChat);

// Send on Enter (Shift+Enter = newline)
chatInput && chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
    // Auto-resize textarea
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
});

chatSend && chatSend.addEventListener('click', sendChatMessage);

function scrollChatToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendBubble(text, role) {
    const div = document.createElement('div');
    div.className = 'chat-bubble ' + role;
    div.textContent = text;
    chatMessages.appendChild(div);
    scrollChatToBottom();
    return div;
}

function appendTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'chat-bubble bot typing';
    div.id = 'typingIndicator';
    div.innerHTML = '<span></span><span></span><span></span>';
    chatMessages.appendChild(div);
    scrollChatToBottom();
    return div;
}

function removeTypingIndicator() {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
}

async function ensureSession() {
    if (chatSessionId) return chatSessionId;

    const res = await apiPost('/chat/start', {});
    if (res.success && res.session_id) {
        chatSessionId = res.session_id;
        localStorage.setItem('chat_session_id', chatSessionId);
    }
    return chatSessionId;
}

async function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    chatInput.value = '';
    chatInput.style.height = 'auto';
    chatSend.disabled = true;

    appendBubble(text, 'user');
    const typing = appendTypingIndicator();

    try {
        const sessionId = await ensureSession();
        const res = await apiPost('/chat/message', {
            session_id: sessionId,
            message:    text,
        });

        removeTypingIndicator();

        if (res.reply) {
            appendBubble(res.reply, 'bot');
        } else if (res.success) {
            appendBubble('Mensaje recibido. Un agente te responderá pronto.', 'bot');
        } else {
            appendBubble('No se pudo enviar el mensaje. Intenta de nuevo.', 'bot');
        }

        // Show badge if chat is closed
        if (!chatOpen) {
            show(chatBadge);
        }

    } catch (_) {
        removeTypingIndicator();
        appendBubble('Error de red. Por favor intenta de nuevo.', 'bot');
    } finally {
        chatSend.disabled = false;
    }
}
