<?php
/**
 * Chat endpoint — chatbot session management & webhook relay
 *
 * POST /api/chat/start          — start a new session
 * POST /api/chat/message        — send a message (relayed to webhook)
 * GET  /api/chat/<session_id>   — get session history
 */

$db = db();

switch (true) {

    // ── Start session ─────────────────────────────────────────────────────────
    case ($method === 'POST' && $action === 'start'):
        $b          = body();
        $rawWebhook = $b['webhook_url'] ?? DEFAULT_WEBHOOK_URL;
        // Validate webhook URL — must be https and must not resolve to a private IP (SSRF)
        $webhookUrl = validate_webhook_url($rawWebhook) ? $rawWebhook : '';
        $sessionId  = bin2hex(random_bytes(16));

        $db->prepare('
            INSERT INTO chat_sessions (session_id, webhook_url, messages)
            VALUES (?, ?, ?)
        ')->execute([$sessionId, $webhookUrl, '[]']);

        json_ok(['success' => true, 'session_id' => $sessionId], 201);


    // ── Send message ──────────────────────────────────────────────────────────
    case ($method === 'POST' && ($action === 'message' || $action === null)):
        $b         = body();
        $sessionId = $b['session_id'] ?? '';
        $message   = htmlspecialchars(trim($b['message'] ?? ''), ENT_QUOTES, 'UTF-8');
        $role      = 'user';

        if (!$sessionId)  json_err('session_id is required');
        if (!$message)    json_err('message is required');
        if (strlen($message) > 2000) json_err('Message too long (max 2000 chars)');

        // Fetch session
        $stmt = $db->prepare('SELECT * FROM chat_sessions WHERE session_id = ?');
        $stmt->execute([$sessionId]);
        $session = $stmt->fetch();

        if (!$session) {
            // Auto-create session if it doesn't exist
            $rawWebhook = $b['webhook_url'] ?? DEFAULT_WEBHOOK_URL;
            $webhookUrl = validate_webhook_url($rawWebhook) ? $rawWebhook : '';
            $db->prepare('
                INSERT INTO chat_sessions (session_id, webhook_url, messages)
                VALUES (?, ?, ?)
            ')->execute([$sessionId, $webhookUrl, '[]']);

            $stmt->execute([$sessionId]);
            $session = $stmt->fetch();
        }

        $messages = json_decode($session['messages'], true) ?? [];

        // Add user message
        $userMsg = [
            'role'      => $role,
            'content'   => $message,
            'timestamp' => date('c'),
        ];
        $messages[] = $userMsg;

        $botReply = null;

        // Relay to webhook — re-validate the stored URL before use
        $webhookUrl = $session['webhook_url'] ?? DEFAULT_WEBHOOK_URL;
        if ($webhookUrl && validate_webhook_url($webhookUrl)) {
            $payload = json_encode([
                'session_id' => $sessionId,
                'message'    => $message,
                'history'    => $messages,
            ]);

            $ch = curl_init($webhookUrl);
            curl_setopt_array($ch, [
                CURLOPT_POST           => true,
                CURLOPT_POSTFIELDS     => $payload,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => 15,
                CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
                CURLOPT_SSL_VERIFYPEER => true,
            ]);
            $webhookResponse = curl_exec($ch);
            $httpCode        = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($webhookResponse && $httpCode >= 200 && $httpCode < 300) {
                $decoded = json_decode($webhookResponse, true);
                // Expect webhook to return {"reply": "..."}
                $botReply = $decoded['reply'] ?? $decoded['message'] ?? $decoded['text'] ?? null;
                if ($botReply) {
                    $messages[] = [
                        'role'      => 'bot',
                        'content'   => htmlspecialchars($botReply, ENT_QUOTES, 'UTF-8'),
                        'timestamp' => date('c'),
                    ];
                }
            }
        }

        // Persist updated messages
        $db->prepare('
            UPDATE chat_sessions
            SET messages = ?, updated_at = datetime("now")
            WHERE session_id = ?
        ')->execute([json_encode($messages), $sessionId]);

        json_ok([
            'success'   => true,
            'reply'     => $botReply,
            'history'   => $messages,
        ]);


    // ── Get session history ───────────────────────────────────────────────────
    case ($method === 'GET' && $id !== null):
        $stmt = $db->prepare('SELECT * FROM chat_sessions WHERE session_id = ?');
        $stmt->execute([$id]);
        $session = $stmt->fetch();

        if (!$session) json_err('Session not found', 404);

        $session['messages'] = json_decode($session['messages'], true) ?? [];
        unset($session['webhook_url']); // don't leak webhook URL to client
        json_ok(['success' => true, 'data' => $session]);


    default:
        json_err('Invalid chat request', 400);
}
