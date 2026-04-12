<?php
/**
 * Users endpoint
 *
 * GET    /api/users          — list users (admin)
 * POST   /api/users          — create user (admin)
 * GET    /api/users/<id>     — get user + their devices (admin)
 * PUT    /api/users/<id>     — update user (admin)
 * DELETE /api/users/<id>     — delete user (admin)
 */

require_api_key();

$db = db();

switch ($method) {
    case 'GET':
        if ($id !== null) {
            // Single user + devices
            $stmt = $db->prepare('SELECT * FROM users WHERE id = ?');
            $stmt->execute([$id]);
            $user = $stmt->fetch();
            if (!$user) json_err('User not found', 404);

            $stmt = $db->prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen DESC');
            $stmt->execute([$id]);
            $user['devices'] = $stmt->fetchAll();

            $stmt = $db->prepare('
                SELECT u.*, v.code AS voucher_code, v.ssid
                FROM usages u
                LEFT JOIN vouchers v ON v.id = u.voucher_id
                WHERE u.user_id = ?
                ORDER BY u.authorized_at DESC
                LIMIT 50
            ');
            $stmt->execute([$id]);
            $user['usages'] = $stmt->fetchAll();

            json_ok(['success' => true, 'data' => $user]);
        }

        // List all users
        $search = '%' . ($_GET['q'] ?? '') . '%';
        $stmt   = $db->prepare('
            SELECT u.*, COUNT(d.id) AS device_count
            FROM users u
            LEFT JOIN devices d ON d.user_id = u.id
            WHERE u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?
            GROUP BY u.id
            ORDER BY u.created_at DESC
            LIMIT 200
        ');
        $stmt->execute([$search, $search, $search]);
        json_ok(['success' => true, 'data' => $stmt->fetchAll()]);

    case 'POST':
        $b     = body();
        $name  = htmlspecialchars(trim($b['name']  ?? ''), ENT_QUOTES, 'UTF-8');
        $email = filter_var($b['email'] ?? '', FILTER_VALIDATE_EMAIL) ?: null;
        $phone = htmlspecialchars(trim($b['phone'] ?? ''), ENT_QUOTES, 'UTF-8') ?: null;

        if (!$name) json_err('Name is required');

        $stmt = $db->prepare('INSERT INTO users (name, email, phone) VALUES (?, ?, ?)');
        $stmt->execute([$name, $email, $phone]);
        $newId = $db->lastInsertId();

        $stmt = $db->prepare('SELECT * FROM users WHERE id = ?');
        $stmt->execute([$newId]);
        json_ok(['success' => true, 'data' => $stmt->fetch()], 201);

    case 'PUT':
        if ($id === null) json_err('User ID required', 400);

        $stmt = $db->prepare('SELECT id FROM users WHERE id = ?');
        $stmt->execute([$id]);
        if (!$stmt->fetch()) json_err('User not found', 404);

        $b     = body();
        $name  = htmlspecialchars(trim($b['name']  ?? ''), ENT_QUOTES, 'UTF-8') ?: null;
        $email = filter_var($b['email'] ?? '', FILTER_VALIDATE_EMAIL) ?: null;
        $phone = htmlspecialchars(trim($b['phone'] ?? ''), ENT_QUOTES, 'UTF-8') ?: null;

        $sets   = [];
        $params = [];
        if ($name)  { $sets[] = 'name = ?';  $params[] = $name; }
        if ($email) { $sets[] = 'email = ?'; $params[] = $email; }
        if ($phone) { $sets[] = 'phone = ?'; $params[] = $phone; }

        if (empty($sets)) json_err('Nothing to update');

        $params[] = $id;
        $db->prepare('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);

        $stmt = $db->prepare('SELECT * FROM users WHERE id = ?');
        $stmt->execute([$id]);
        json_ok(['success' => true, 'data' => $stmt->fetch()]);

    case 'DELETE':
        if ($id === null) json_err('User ID required', 400);
        $db->prepare('UPDATE devices SET user_id = NULL WHERE user_id = ?')->execute([$id]);
        $db->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
        json_ok(['success' => true, 'message' => 'User deleted']);

    default:
        json_err('Method not allowed', 405);
}
