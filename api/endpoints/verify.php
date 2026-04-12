<?php
/**
 * Verify endpoint
 *
 * GET /api/verify/<mac>?site=<site>
 *
 * Checks whether a device has an active authorized session in UniFi and
 * whether it actually has internet access. Useful for the captive portal
 * to poll after authorization to avoid the "already authorized but no
 * internet" issue caused by AP sync delays.
 */

$mac  = sanitize_mac($id ?? '');
$site = preg_replace('/[^a-zA-Z0-9_\-]/', '', $_GET['site'] ?? UNIFI_SITE);

if (!validate_mac($mac)) {
    json_err('Invalid MAC address — pass MAC as /api/verify/<mac>');
}

if ($method !== 'GET') {
    json_err('Method not allowed', 405);
}

// Check UniFi
$authorized = false;
$error      = null;

try {
    $ctrl       = unifi($site);
    $authorized = $ctrl->isAuthorized($mac, $site);
} catch (Throwable $e) {
    $error = $e->getMessage();
}

// Check local DB for active usage record
$db   = db();
$stmt = $db->prepare('
    SELECT * FROM usages
    WHERE mac_address = ?
      AND (expires_at IS NULL OR expires_at > datetime("now"))
    ORDER BY authorized_at DESC
    LIMIT 1
');
$stmt->execute([$mac]);
$localRecord = $stmt->fetch();

json_ok([
    'success'      => true,
    'mac'          => $mac,
    'authorized'   => $authorized,
    'local_record' => $localRecord ?: null,
    'error'        => $error,
]);
