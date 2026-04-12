<?php
/**
 * UniFiOs Captive Portal — Configuration
 * Copy this file to config.local.php and adjust values.
 * config.local.php is git-ignored so secrets stay out of version control.
 */

// ─── UniFi Controller ────────────────────────────────────────────────────────
define('UNIFI_HOST',     getenv('UNIFI_HOST')     ?: 'https://192.168.1.1');
define('UNIFI_PORT',     (int)(getenv('UNIFI_PORT') ?: 443));
define('UNIFI_USER',     getenv('UNIFI_USER')     ?: 'admin');
define('UNIFI_PASS',     getenv('UNIFI_PASS')     ?: 'changeme');
define('UNIFI_SITE',     getenv('UNIFI_SITE')     ?: 'default');
define('UNIFI_VERSION',  getenv('UNIFI_VERSION')  ?: '8');   // 5 | 6 | 7 | 8
// Set UNIFI_VERIFY_SSL=true when your controller uses a valid/trusted certificate
define('UNIFI_VERIFY_SSL', filter_var(getenv('UNIFI_VERIFY_SSL') ?: false, FILTER_VALIDATE_BOOLEAN));

// ─── Database ────────────────────────────────────────────────────────────────
define('DB_PATH', __DIR__ . '/../database/portal.sqlite');

// ─── Security ────────────────────────────────────────────────────────────────
// API key required in X-API-Key header for admin endpoints
define('API_KEY', getenv('API_KEY') ?: 'change-this-secret-api-key');

// ─── Chatbot Webhook ─────────────────────────────────────────────────────────
// Default webhook URL (can be overridden per session)
define('DEFAULT_WEBHOOK_URL', getenv('CHATBOT_WEBHOOK_URL') ?: '');

// ─── Captive Portal ──────────────────────────────────────────────────────────
// Number of seconds to wait before verifying internet access after auth
define('AUTH_VERIFY_DELAY', 8);
// How many times to retry verification
define('AUTH_VERIFY_RETRIES', 5);

// ─── CORS ────────────────────────────────────────────────────────────────────
define('ALLOWED_ORIGINS', ['*']);   // restrict in production

// ─── Load local overrides ────────────────────────────────────────────────────
$_local = __DIR__ . '/config.local.php';
if (file_exists($_local)) {
    require_once $_local;
}
