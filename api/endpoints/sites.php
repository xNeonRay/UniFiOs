<?php
/**
 * Sites endpoint  (admin)
 *
 * GET /api/sites  — list all UniFi sites
 */

require_api_key();

if ($method !== 'GET') {
    json_err('Method not allowed', 405);
}

try {
    $ctrl  = unifi();
    $sites = $ctrl->listSites();
    json_ok(['success' => true, 'data' => $sites]);
} catch (Throwable $e) {
    json_err('UniFi error: ' . $e->getMessage(), 502);
}
