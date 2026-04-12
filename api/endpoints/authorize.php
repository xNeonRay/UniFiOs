<?php
/**
 * POST /api/authorize
 *
 * Authorize a device by MAC address in a given site/SSID.
 * Also handles the re-auth edge case: if the device is already authorized,
 * we verify internet access instead of trying to re-authorize.
 *
 * Body (JSON):
 *   mac       string  required  Client MAC address
 *   ap_mac    string  optional  AP MAC address (helps UniFi route correctly)
 *   site      string  optional  UniFi site name (defaults to config UNIFI_SITE)
 *   ssid      string  optional  SSID the client is connecting on
 *   minutes   int     optional  Session duration in minutes (default 480)
 *   up_kbps   int     optional  Upload speed limit kbps
 *   down_kbps int     optional  Download speed limit kbps
 *   quota_mb  int     optional  Traffic quota MB
 */

if ($method !== 'POST') {
    json_err('Method not allowed', 405);
}

$body     = body();
$rawMac   = $body['mac'] ?? '';
$mac      = sanitize_mac($rawMac);
$apMac    = sanitize_mac($body['ap_mac'] ?? '') ?: '';
$site     = preg_replace('/[^a-zA-Z0-9_\-]/', '', $body['site'] ?? UNIFI_SITE);
$ssid     = htmlspecialchars($body['ssid'] ?? '', ENT_QUOTES, 'UTF-8');
$minutes  = max(1, (int)($body['minutes'] ?? 480));
$upKbps   = isset($body['up_kbps'])   ? (int)$body['up_kbps']   : null;
$downKbps = isset($body['down_kbps']) ? (int)$body['down_kbps'] : null;
$quotaMb  = isset($body['quota_mb'])  ? (int)$body['quota_mb']  : null;

if (!$mac || !validate_mac($mac)) {
    json_err('Invalid or missing MAC address');
}

$pdo = db();

// ── Check if device is already authorized in UniFi ───────────────────────────
try {
    $ctrl = unifi($site);

    $alreadyAuthorized = $ctrl->isAuthorized($mac, $site);

    if ($alreadyAuthorized) {
        // Update last_seen in local DB
        $pdo->prepare('UPDATE devices SET last_seen = datetime("now") WHERE mac_address = ?')
            ->execute([$mac]);

        json_ok([
            'success'    => true,
            'authorized' => true,
            'message'    => 'Device is already authorized',
            'mac'        => $mac,
        ]);
    }

    // Not yet authorized — authorize now
    $ctrl->authorizeClient($mac, $minutes, $upKbps, $downKbps, $quotaMb, $apMac, $site);

} catch (Throwable $e) {
    json_err('UniFi authorization failed: ' . $e->getMessage(), 502);
}

// ── Upsert device record ──────────────────────────────────────────────────────
$stmt = $pdo->prepare('SELECT id FROM devices WHERE mac_address = ?');
$stmt->execute([$mac]);
$device = $stmt->fetch();

if ($device) {
    $pdo->prepare('UPDATE devices SET last_seen = datetime("now") WHERE mac_address = ?')
        ->execute([$mac]);
    $deviceId = $device['id'];
} else {
    $pdo->prepare('INSERT INTO devices (mac_address, last_seen) VALUES (?, datetime("now"))')
        ->execute([$mac]);
    $deviceId = $pdo->lastInsertId();
}

// ── Record usage ──────────────────────────────────────────────────────────────
$expiresAt = date('Y-m-d H:i:s', time() + $minutes * 60);
$pdo->prepare('
    INSERT INTO usages (device_id, mac_address, ssid, site_id, expires_at)
    VALUES (?, ?, ?, ?, ?)
')->execute([$deviceId, $mac, $ssid, $site, $expiresAt]);

// ── Verify internet access with retries (handles AP sync delay) ───────────────
$verification = verify_internet_access($mac, $site);

json_ok([
    'success'         => true,
    'authorized'      => true,
    'internet_access' => $verification['authorized'],
    'mac'             => $mac,
    'site'            => $site,
    'expires_at'      => $expiresAt,
    'message'         => $verification['authorized']
        ? 'Device authorized and internet access confirmed'
        : 'Device authorized but internet access could not be confirmed yet — AP may still be syncing',
]);
