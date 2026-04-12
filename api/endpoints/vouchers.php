<?php
/**
 * Vouchers endpoint
 *
 * GET    /api/vouchers           — list vouchers (admin)
 * POST   /api/vouchers           — create voucher (admin)
 * DELETE /api/vouchers/<id>      — delete voucher (admin)
 * POST   /api/vouchers/redeem    — redeem a voucher (public, from captive portal)
 */

$db = db();

switch (true) {

    // ── LIST ─────────────────────────────────────────────────────────────────
    case ($method === 'GET' && $action === null && $id === null):
        require_api_key();

        $site   = preg_replace('/[^a-zA-Z0-9_\-]/', '', $_GET['site'] ?? '');
        $active = isset($_GET['active']) ? (int)$_GET['active'] : null;
        $ssid   = $_GET['ssid'] ?? null;

        $where  = [];
        $params = [];
        if ($site)          { $where[] = 'v.site_id = ?';   $params[] = $site; }
        if ($active !== null){ $where[] = 'v.is_active = ?'; $params[] = $active; }
        if ($ssid !== null)  { $where[] = 'v.ssid = ?';      $params[] = $ssid; }

        $sql = 'SELECT v.*, COUNT(u.id) AS redemption_count
                FROM vouchers v
                LEFT JOIN usages u ON u.voucher_id = v.id
                ' . ($where ? 'WHERE ' . implode(' AND ', $where) : '') . '
                GROUP BY v.id
                ORDER BY v.created_at DESC
                LIMIT 500';

        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        json_ok(['success' => true, 'data' => $stmt->fetchAll()]);


    // ── CREATE ───────────────────────────────────────────────────────────────
    case ($method === 'POST' && ($action === null || $action === 'create') && $id === null):
        require_api_key();

        $b             = body();
        $site          = preg_replace('/[^a-zA-Z0-9_\-]/', '', $b['site'] ?? UNIFI_SITE);
        $ssid          = htmlspecialchars($b['ssid'] ?? '', ENT_QUOTES, 'UTF-8') ?: null;
        $duration      = max(1, (int)($b['duration_minutes'] ?? 480));
        $quotaMb       = isset($b['quota_mb'])  ? (int)$b['quota_mb']  : null;
        $maxUses       = max(1, (int)($b['max_uses'] ?? 1));
        $count         = max(1, min(200, (int)($b['count'] ?? 1)));
        $note          = htmlspecialchars($b['note'] ?? '', ENT_QUOTES, 'UTF-8');
        $syncUnifi     = (bool)($b['sync_unifi'] ?? true);
        $upKbps        = isset($b['up_kbps'])   ? (int)$b['up_kbps']   : null;
        $downKbps      = isset($b['down_kbps']) ? (int)$b['down_kbps'] : null;

        $created = [];

        // Optionally sync with UniFi controller first
        $unifiIds = [];
        if ($syncUnifi) {
            try {
                $ctrl      = unifi($site);
                $unifiVouchers = $ctrl->createVouchers(
                    $count, $duration, $maxUses, $quotaMb, $upKbps, $downKbps, $note, $site
                );
                foreach ($unifiVouchers as $uv) {
                    $rawCode = preg_replace('/[^A-Z0-9]/i', '', $uv['code'] ?? '');
                    $formattedCode = strlen($rawCode) === 10
                        ? strtoupper(substr($rawCode, 0, 5) . '-' . substr($rawCode, 5, 5))
                        : null;
                    $unifiIds[] = [
                        'id'   => $uv['_id']  ?? null,
                        'code' => $formattedCode,
                    ];
                }
            } catch (Throwable $e) {
                // UniFi sync failed — continue with local-only vouchers
                $syncUnifi = false;
            }
        }

        $stmt = $db->prepare('
            INSERT INTO vouchers
                (code, site_id, ssid, duration_minutes, quota_mb, max_uses, note, unifi_voucher_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ');

        for ($i = 0; $i < $count; $i++) {
            $code     = !empty($unifiIds[$i]['code']) ? $unifiIds[$i]['code'] : generate_voucher_code();
            $unifiId  = $unifiIds[$i]['id'] ?? null;

            $stmt->execute([$code, $site, $ssid, $duration, $quotaMb, $maxUses, $note, $unifiId]);
            $created[] = [
                'id'               => $db->lastInsertId(),
                'code'             => $code,
                'site_id'          => $site,
                'ssid'             => $ssid,
                'duration_minutes' => $duration,
                'quota_mb'         => $quotaMb,
                'max_uses'         => $maxUses,
                'unifi_voucher_id' => $unifiId,
                'note'             => $note,
            ];
        }

        json_ok([
            'success'      => true,
            'synced_unifi' => $syncUnifi,
            'data'         => $created,
        ], 201);


    // ── REDEEM ───────────────────────────────────────────────────────────────
    case ($method === 'POST' && $action === 'redeem'):
        $b    = body();
        $code = strtoupper(trim($b['code'] ?? ''));
        $mac  = sanitize_mac($b['mac'] ?? '');
        $ssid = htmlspecialchars($b['ssid'] ?? '', ENT_QUOTES, 'UTF-8');
        $site = preg_replace('/[^a-zA-Z0-9_\-]/', '', $b['site'] ?? UNIFI_SITE);

        if (!$code)             json_err('Voucher code is required');
        if (!validate_mac($mac)) json_err('Invalid MAC address');

        // ── Fetch voucher ─────────────────────────────────────────────────────
        $stmt = $db->prepare('SELECT * FROM vouchers WHERE code = ?');
        $stmt->execute([$code]);
        $voucher = $stmt->fetch();

        if (!$voucher)             json_err('Voucher not found', 404);
        if (!$voucher['is_active']) json_err('Voucher is no longer active');
        if ($voucher['used_count'] >= $voucher['max_uses']) json_err('Voucher has already been fully used');
        if ($voucher['expires_at'] && $voucher['expires_at'] < date('Y-m-d H:i:s')) {
            json_err('Voucher has expired');
        }

        // ── SSID validation ────────────────────────────────────────────────────
        // If the voucher is tied to a specific SSID, reject use on other SSIDs
        if ($voucher['ssid'] && $ssid && strtolower($voucher['ssid']) !== strtolower($ssid)) {
            json_err(
                'This voucher can only be used on the "' . $voucher['ssid'] . '" network, ' .
                'but you are connected to "' . $ssid . '"',
                403
            );
        }

        // ── Site validation ────────────────────────────────────────────────────
        if ($voucher['site_id'] && $site && $voucher['site_id'] !== $site) {
            json_err('This voucher is not valid for this site', 403);
        }

        // ── Check if this MAC already used this voucher ────────────────────────
        $stmt = $db->prepare('SELECT id FROM usages WHERE voucher_id = ? AND mac_address = ?');
        $stmt->execute([$voucher['id'], $mac]);
        if ($stmt->fetch()) {
            // Already redeemed — just verify/re-authorize
            try {
                $ctrl = unifi($site);
                if (!$ctrl->isAuthorized($mac, $site)) {
                    $ctrl->authorizeClient($mac, (int)$voucher['duration_minutes'], null, null, $voucher['quota_mb'] ?: null, '', $site);
                }
            } catch (Throwable $e) {
                // ignore — best effort
            }
            json_ok(['success' => true, 'message' => 'Voucher already used by this device — re-authorized', 'mac' => $mac]);
        }

        // ── Upsert device ──────────────────────────────────────────────────────
        $stmt = $db->prepare('SELECT id FROM devices WHERE mac_address = ?');
        $stmt->execute([$mac]);
        $device = $stmt->fetch();
        if ($device) {
            $db->prepare('UPDATE devices SET last_seen = datetime("now") WHERE id = ?')->execute([$device['id']]);
            $deviceId = $device['id'];
        } else {
            $db->prepare('INSERT INTO devices (mac_address, last_seen) VALUES (?, datetime("now"))')->execute([$mac]);
            $deviceId = $db->lastInsertId();
        }

        // ── Authorize in UniFi ─────────────────────────────────────────────────
        $expiresAt = date('Y-m-d H:i:s', time() + (int)$voucher['duration_minutes'] * 60);
        try {
            $ctrl = unifi($site);
            $ctrl->authorizeClient(
                $mac,
                (int)$voucher['duration_minutes'],
                null, null,
                $voucher['quota_mb'] ? (int)$voucher['quota_mb'] : null,
                '',
                $site
            );
        } catch (Throwable $e) {
            json_err('Authorization failed: ' . $e->getMessage(), 502);
        }

        // ── Record usage & update voucher ──────────────────────────────────────
        $db->beginTransaction();
        try {
            $db->prepare('
                INSERT INTO usages (voucher_id, device_id, mac_address, ssid, site_id, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)
            ')->execute([$voucher['id'], $deviceId, $mac, $ssid, $site, $expiresAt]);

            $db->prepare('
                UPDATE vouchers
                SET used_count = used_count + 1,
                    is_active  = CASE WHEN used_count + 1 >= max_uses THEN 0 ELSE is_active END
                WHERE id = ?
            ')->execute([$voucher['id']]);

            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            json_err('Database error: ' . $e->getMessage(), 500);
        }

        // ── Verify internet access (AP sync delay mitigation) ─────────────────
        $verification = verify_internet_access($mac, $site);

        json_ok([
            'success'         => true,
            'authorized'      => true,
            'internet_access' => $verification['authorized'],
            'mac'             => $mac,
            'expires_at'      => $expiresAt,
            'message'         => $verification['authorized']
                ? 'Voucher redeemed — internet access confirmed'
                : 'Voucher redeemed — internet access not yet confirmed (AP syncing)',
        ]);


    // ── DELETE ───────────────────────────────────────────────────────────────
    case ($method === 'DELETE' && $id !== null):
        require_api_key();

        $stmt = $db->prepare('SELECT * FROM vouchers WHERE id = ?');
        $stmt->execute([$id]);
        $voucher = $stmt->fetch();
        if (!$voucher) json_err('Voucher not found', 404);

        // Remove from UniFi if synced
        if ($voucher['unifi_voucher_id']) {
            try {
                $ctrl = unifi($voucher['site_id'] ?? UNIFI_SITE);
                $ctrl->deleteVoucher($voucher['unifi_voucher_id'], $voucher['site_id'] ?? UNIFI_SITE);
            } catch (Throwable $e) {
                // log but don't block local deletion
            }
        }

        $db->prepare('DELETE FROM vouchers WHERE id = ?')->execute([$id]);
        json_ok(['success' => true, 'message' => 'Voucher deleted']);


    default:
        json_err('Invalid vouchers request', 400);
}
