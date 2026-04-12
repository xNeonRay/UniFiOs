<?php
/**
 * API Entry point — routes requests to handlers.
 *
 * URL pattern expected:  /api/<resource>[/<id>][/<action>]
 * Example:               /api/vouchers/redeem
 *                        /api/authorize
 *                        /api/users/5
 */
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/helpers.php';

cors();

$method = strtoupper($_SERVER['REQUEST_METHOD']);
$uri    = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);

// Strip /api prefix
$uri = preg_replace('#^/?api/?#', '', $uri);
$uri = trim($uri, '/');

$parts    = explode('/', $uri);
$resource = $parts[0] ?? '';
$id       = $parts[1] ?? null;
$action   = $parts[2] ?? null;

// If $id looks like an action word (not numeric), treat it as action
if ($id !== null && !is_numeric($id)) {
    $action = $id;
    $id     = null;
}

switch ($resource) {
    case 'authorize':
        require __DIR__ . '/endpoints/authorize.php';
        break;

    case 'vouchers':
        require __DIR__ . '/endpoints/vouchers.php';
        break;

    case 'users':
        require __DIR__ . '/endpoints/users.php';
        break;

    case 'devices':
        require __DIR__ . '/endpoints/devices.php';
        break;

    case 'chat':
        require __DIR__ . '/endpoints/chat.php';
        break;

    case 'verify':
        require __DIR__ . '/endpoints/verify.php';
        break;

    case 'sites':
        require __DIR__ . '/endpoints/sites.php';
        break;

    default:
        json_err('Unknown endpoint', 404);
}
