<?php
/**
 * Shared helpers: JSON responses, CORS, auth middleware.
 */
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/UniFiController.php';

// ─── CORS ─────────────────────────────────────────────────────────────────────
function cors(): void
{
    $origin  = $_SERVER['HTTP_ORIGIN'] ?? '*';
    $allowed = ALLOWED_ORIGINS;
    if (\in_array('*', $allowed, true)) {
        header('Access-Control-Allow-Origin: *');
    } elseif (\in_array($origin, $allowed, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
    }
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-API-Key');
    header('Access-Control-Max-Age: 86400');

    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────
function json_ok(array $data, int $code = 200): never
{
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

function json_err(string $message, int $code = 400, array $extra = []): never
{
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode(array_merge(['success' => false, 'error' => $message], $extra),
        JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

// ─── Request body ─────────────────────────────────────────────────────────────
function body(): array
{
    $raw = file_get_contents('php://input');
    if (empty($raw)) {
        return $_POST;
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : $_POST;
}

// ─── API key middleware ────────────────────────────────────────────────────────
function require_api_key(): void
{
    $key = $_SERVER['HTTP_X_API_KEY'] ?? ($_GET['api_key'] ?? '');
    if ($key !== API_KEY) {
        json_err('Unauthorized – invalid or missing API key', 401);
    }
}

// ─── UniFi controller factory ────────────────────────────────────────────────
function unifi(string $site = ''): UniFiController
{
    return new UniFiController(
        UNIFI_HOST,
        UNIFI_PORT,
        UNIFI_USER,
        UNIFI_PASS,
        $site ?: UNIFI_SITE,
        UNIFI_VERSION
    );
}

// ─── Input sanitization ───────────────────────────────────────────────────────
function sanitize_mac(string $mac): string
{
    $mac = preg_replace('/[^a-fA-F0-9]/', '', $mac);
    if (strlen($mac) !== 12) {
        return '';
    }
    return implode(':', str_split(strtolower($mac), 2));
}

function validate_mac(string $mac): bool
{
    return (bool) preg_match('/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i', $mac);
}

// ─── Internet connectivity check ──────────────────────────────────────────────
/**
 * Verify that a MAC address has internet access by checking its guest status
 * in UniFi, with retries to handle AP sync delay.
 */
function verify_internet_access(string $mac, string $site): array
{
    $retries = AUTH_VERIFY_RETRIES;
    $delay   = AUTH_VERIFY_DELAY;

    for ($i = 0; $i < $retries; $i++) {
        if ($i > 0) {
            sleep($delay);
        }
        try {
            $ctrl = unifi($site);
            if ($ctrl->isAuthorized($mac, $site)) {
                return ['authorized' => true, 'attempt' => $i + 1];
            }
        } catch (Throwable $e) {
            // ignore transient errors
        }
    }
    return ['authorized' => false, 'attempts' => $retries];
}

// ─── Voucher helpers ──────────────────────────────────────────────────────────
function generate_voucher_code(int $length = 10): string
{
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $code  = '';
    for ($i = 0; $i < $length; $i++) {
        $code .= $chars[random_int(0, strlen($chars) - 1)];
    }
    // Format as XXXXX-XXXXX
    return substr($code, 0, 5) . '-' . substr($code, 5, 5);
}
