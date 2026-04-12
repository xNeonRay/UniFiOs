<?php
/**
 * Devices endpoint
 *
 * GET    /api/devices               — list devices (admin)
 * GET    /api/devices/<id>          — device detail + usage history
 * PUT    /api/devices/<id>          — assign user to device
 * DELETE /api/devices/<id>          — delete device record
 * POST   /api/devices/unauthorize   — unauthorize a device from UniFi
 */

require_api_key();

$db = db();

switch (true) {

    case ($method === 'GET' && $id !== null):
        $stmt = $db->prepare('
            SELECT d.*, u.name AS user_name, u.email AS user_email
            FROM devices d
            LEFT JOIN users u ON u.id = d.user_id
            WHERE d.id = ?
        ');
        $stmt->execute([$id]);
        $device = $stmt->fetch();
        if (!$device) json_err('Device not found', 404);

        $stmt = $db->prepare('
            SELECT u.*, v.code AS voucher_code, v.ssid
            FROM usages u
            LEFT JOIN vouchers v ON v.id = u.voucher_id
            WHERE u.device_id = ?
            ORDER BY u.authorized_at DESC
            LIMIT 50
        ');
        $stmt->execute([$id]);
        $device['usages'] = $stmt->fetchAll();

        json_ok(['success' => true, 'data' => $device]);

    case ($method === 'GET'):
        $search = '%' . ($_GET['q'] ?? '') . '%';
        $stmt = $db->prepare('
            SELECT d.*, u.name AS user_name
            FROM devices d
            LEFT JOIN users u ON u.id = d.user_id
            WHERE d.mac_address LIKE ? OR d.hostname LIKE ? OR u.name LIKE ?
            ORDER BY d.last_seen DESC
            LIMIT 200
        ');
        $stmt->execute([$search, $search, $search]);
        json_ok(['success' => true, 'data' => $stmt->fetchAll()]);

    case ($method === 'PUT' && $id !== null):
        $b = body();
        $userId   = isset($b['user_id']) ? (int)$b['user_id'] : null;
        $hostname = htmlspecialchars(trim($b['hostname'] ?? ''), ENT_QUOTES, 'UTF-8') ?: null;

        $stmt = $db->prepare('SELECT id FROM devices WHERE id = ?');
        $stmt->execute([$id]);
        if (!$stmt->fetch()) json_err('Device not found', 404);

        $sets   = [];
        $params = [];
        if ($userId !== null) { $sets[] = 'user_id = ?';   $params[] = $userId; }
        if ($hostname)        { $sets[] = 'hostname = ?';  $params[] = $hostname; }
        if (empty($sets))     json_err('Nothing to update');

        $params[] = $id;
        $db->prepare('UPDATE devices SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);
        json_ok(['success' => true, 'message' => 'Device updated']);

    case ($method === 'DELETE' && $id !== null):
        $db->prepare('DELETE FROM devices WHERE id = ?')->execute([$id]);
        json_ok(['success' => true, 'message' => 'Device deleted']);

    case ($method === 'POST' && $action === 'unauthorize'):
        $b    = body();
        $mac  = sanitize_mac($b['mac'] ?? '');
        $site = preg_replace('/[^a-zA-Z0-9_\-]/', '', $b['site'] ?? UNIFI_SITE);

        if (!validate_mac($mac)) json_err('Invalid MAC address');

        try {
            $ctrl = unifi($site);
            $ctrl->unauthorizeClient($mac, $site);
        } catch (Throwable $e) {
            json_err('UniFi error: ' . $e->getMessage(), 502);
        }

        json_ok(['success' => true, 'message' => 'Device unauthorized', 'mac' => $mac]);

    default:
        json_err('Invalid devices request', 400);
}
