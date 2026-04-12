<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Portal de Acceso WiFi</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="stylesheet" href="assets/portal.css">
</head>
<body>
<?php
/**
 * Captive Portal — main page
 *
 * UniFi passes these query parameters when redirecting a guest:
 *   id   = AP MAC
 *   ap   = AP MAC (alias)
 *   ssid = SSID name
 *   t    = timestamp
 *   url  = original URL the client tried to visit
 *   mac  = client MAC address (some versions)
 */

$rawMac    = $_GET['mac'] ?? '';    // used for API checks (raw, unsanitized for HTML)
$clientMac = htmlspecialchars($rawMac,              ENT_QUOTES, 'UTF-8');
$apMac     = htmlspecialchars($_GET['ap']  ?? $_GET['id'] ?? '', ENT_QUOTES, 'UTF-8');
$ssid      = htmlspecialchars($_GET['ssid'] ?? '',              ENT_QUOTES, 'UTF-8');

// Validate redirect URL to prevent open redirect — only allow http/https URLs
$rawRedirect = $_GET['url'] ?? '';
$redirectUrl = (filter_var($rawRedirect, FILTER_VALIDATE_URL) && preg_match('#^https?://#i', $rawRedirect))
    ? htmlspecialchars($rawRedirect, ENT_QUOTES, 'UTF-8')
    : 'https://google.com';

// Site can be injected via URL param (set in UniFi portal settings)
$site = preg_replace('/[^a-zA-Z0-9_\-]/', '', $_GET['site'] ?? 'default');

// ── Caso 1: device already authorized ────────────────────────────────────────
// When an AP reboots it loses its authorization cache and redirects the device
// to the portal even though it still has a valid session in the controller.
// Check here and redirect immediately so the user never sees the portal form.
if ($rawMac !== '') {
    require_once __DIR__ . '/../api/config.php';
    require_once __DIR__ . '/../api/lib/UniFiController.php';
    try {
        $ctrl = new UniFiController(
            UNIFI_HOST, UNIFI_PORT, UNIFI_USER, UNIFI_PASS,
            $site ?: UNIFI_SITE, UNIFI_VERSION, UNIFI_VERIFY_SSL
        );
        if ($ctrl->isAuthorized($rawMac, $site ?: UNIFI_SITE)) {
            // Device is already authorized — send it straight to its destination.
            header('Location: ' . $redirectUrl);
            exit;
        }
    } catch (Throwable $e) {
        // UniFi unreachable — fall through and show the portal normally.
    }
}
?>

<div class="portal-wrapper">
    <!-- Header / Logo -->
    <header class="portal-header">
        <div class="logo">
            <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="24" cy="24" r="23" stroke="#2563eb" stroke-width="2"/>
                <path d="M24 12 C14 12, 8 18, 8 24 C8 30, 14 36, 24 36 C34 36, 40 30, 40 24"
                      stroke="#2563eb" stroke-width="2.5" stroke-linecap="round" fill="none"/>
                <circle cx="24" cy="24" r="4" fill="#2563eb"/>
            </svg>
        </div>
        <h1>Portal WiFi</h1>
        <p class="subtitle">Ingresa tu voucher para conectarte</p>
    </header>

    <!-- Network info badge -->
    <?php if ($ssid): ?>
    <div class="network-badge">
        <span class="wifi-icon">📶</span>
        <span>Red: <strong><?= $ssid ?></strong></span>
    </div>
    <?php endif; ?>

    <!-- Main card -->
    <main class="portal-card" id="mainCard">

        <!-- Step 1: Enter voucher -->
        <section id="stepVoucher" class="step active">
            <h2>Acceso a Internet</h2>
            <p class="hint">Ingresa el código de tu voucher para activar tu sesión.</p>

            <form id="voucherForm" novalidate>
                <div class="field-group">
                    <label for="voucherCode">Código de Voucher</label>
                    <input type="text"
                           id="voucherCode"
                           name="code"
                           placeholder="XXXXX-XXXXX"
                           maxlength="11"
                           autocomplete="off"
                           autocapitalize="characters"
                           spellcheck="false"
                           required>
                    <span class="field-hint">Formato: XXXXX-XXXXX</span>
                </div>

                <div id="voucherError" class="error-box hidden"></div>

                <button type="submit" class="btn btn-primary" id="redeemBtn">
                    <span class="btn-text">Conectarme</span>
                    <span class="btn-spinner hidden"></span>
                </button>
            </form>

            <p class="alt-action">¿No tienes voucher? <a href="#" id="openChatLink">Solicita uno aquí →</a></p>
        </section>

        <!-- Step 2: Connecting -->
        <section id="stepConnecting" class="step">
            <div class="connecting-animation">
                <div class="ring"></div>
                <div class="ring"></div>
                <div class="ring"></div>
            </div>
            <h2>Conectando…</h2>
            <p id="connectingMsg">Autorizando tu dispositivo, por favor espera.</p>
            <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
        </section>

        <!-- Step 3: Success -->
        <section id="stepSuccess" class="step">
            <div class="success-icon">✓</div>
            <h2>¡Conectado!</h2>
            <p id="successMsg">Tu dispositivo tiene acceso a internet.</p>
            <p class="expires-info" id="expiresInfo"></p>
            <a href="<?= $redirectUrl ?>" class="btn btn-success" id="continueBtn">Continuar navegando →</a>
        </section>

        <!-- Step 4: Error final -->
        <section id="stepError" class="step">
            <div class="error-icon">✕</div>
            <h2>No se pudo conectar</h2>
            <p id="errorMsg">Ocurrió un error al procesar tu voucher.</p>
            <button class="btn btn-outline" id="retryBtn">Intentar nuevamente</button>
        </section>

    </main>

    <footer class="portal-footer">
        <p>¿Necesitas ayuda? <a href="#" id="openChatFooter">Habla con nosotros</a></p>
    </footer>
</div>

<!-- ═══════════════════════════════════════════════════════ Chat Widget ══════ -->
<div id="chatWidget" class="chat-widget" aria-hidden="true">
    <button id="chatToggle" class="chat-toggle" aria-label="Abrir chat de soporte">
        <span class="chat-icon">💬</span>
        <span class="chat-badge hidden" id="chatBadge">1</span>
    </button>

    <div id="chatWindow" class="chat-window hidden" role="dialog" aria-label="Chat de soporte">
        <div class="chat-header">
            <div class="chat-avatar">🤖</div>
            <div class="chat-title">
                <strong>Soporte WiFi</strong>
                <span class="chat-status">En línea</span>
            </div>
            <button class="chat-close" id="chatClose" aria-label="Cerrar chat">✕</button>
        </div>

        <div class="chat-messages" id="chatMessages">
            <div class="chat-bubble bot">
                👋 ¡Hola! Soy tu asistente de WiFi. ¿En qué te puedo ayudar?
            </div>
        </div>

        <div class="chat-input-area">
            <textarea id="chatInput"
                      placeholder="Escribe tu mensaje…"
                      rows="1"
                      maxlength="2000"
                      aria-label="Mensaje"></textarea>
            <button id="chatSend" class="btn-send" aria-label="Enviar">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
            </button>
        </div>
    </div>
</div>

<!-- Hidden data for JS -->
<script>
    window.PORTAL_CONFIG = {
        apiBase:     '/api',
        clientMac:   <?= json_encode($clientMac) ?>,
        apMac:       <?= json_encode($apMac) ?>,
        ssid:        <?= json_encode($ssid) ?>,
        site:        <?= json_encode($site) ?>,
        redirectUrl: <?= json_encode($redirectUrl) ?>,
    };
</script>
<script src="assets/portal.js"></script>
</body>
</html>
