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
    // Accept the key only from the X-API-Key request header.
    // Never read it from $_GET — query-string API keys appear in server logs,
    // browser history, and Referer headers, which is a security risk.
    $key = $_SERVER['HTTP_X_API_KEY'] ?? '';
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
        UNIFI_VERSION,
        UNIFI_VERIFY_SSL
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
 * in UniFi immediately after authorization.
 *
 * A single attempt is made here; if the AP has not yet synced the authorization
 * the client-side pollVerify() function will continue polling asynchronously,
 * keeping this PHP worker free rather than blocking for multiple sleep() cycles.
 */
function verify_internet_access(string $mac, string $site): array
{
    try {
        $ctrl = unifi($site);
        if ($ctrl->isAuthorized($mac, $site)) {
            return ['authorized' => true, 'attempt' => 1];
        }
    } catch (Throwable $e) {
        // ignore transient errors
    }
    return ['authorized' => false, 'attempts' => 1];
}

// ─── Webhook URL validation (SSRF protection) ─────────────────────────────────
/**
 * Validate that a webhook URL is safe to call:
 *   - Must be a valid URL with https scheme
 *   - Hostname must not resolve to a private/loopback IP range
 *
 * Private ranges blocked: 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, ::1, fc00::/7
 */
function validate_webhook_url(string $url): bool
{
    if (!$url) {
        return false;
    }

    // Must be a valid https URL
    if (!filter_var($url, FILTER_VALIDATE_URL) || !preg_match('#^https://#i', $url)) {
        return false;
    }

    $host = parse_url($url, PHP_URL_HOST);
    if (!$host) {
        return false;
    }

    // Strip IPv6 brackets
    $host = trim($host, '[]');

    // Resolve hostname to IP(s); block if any resolve to a private range
    $ips = @gethostbynamel($host);
    if ($ips === false) {
        // Could not resolve — treat as safe to allow offline-dev but log if needed
        $ips = [$host];
    }

    $privatePatterns = [
        '#^127\.#',                     // loopback
        '#^10\.#',                      // RFC1918
        '#^172\.(1[6-9]|2\d|3[01])\.#', // RFC1918
        '#^192\.168\.#',                // RFC1918
        '#^169\.254\.#',               // link-local
        '#^::1$#',                     // IPv6 loopback
        '#^fc#i',                      // IPv6 unique-local (fc00::/7)
        '#^fd#i',                      // IPv6 unique-local (fd00::/8)
    ];

    foreach ($ips as $ip) {
        foreach ($privatePatterns as $pattern) {
            if (preg_match($pattern, $ip)) {
                return false;
            }
        }
    }

    return true;
}

// ─── Voucher helpers ──────────────────────────────────────────────────────────
function generate_voucher_code(int $length = 10): string
{
    $chars    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $charsLen = strlen($chars);
    $code     = '';
    for ($i = 0; $i < $length; $i++) {
        $code .= $chars[random_int(0, $charsLen - 1)];
    }
    // Format as XXXXX-XXXXX
    return substr($code, 0, 5) . '-' . substr($code, 5, 5);
}
