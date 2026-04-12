<?php
/**
 * Database initialisation and connection (SQLite via PDO).
 */
require_once __DIR__ . '/../config.php';

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $dir = dirname(DB_PATH);
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }

    $pdo = new PDO('sqlite:' . DB_PATH, null, null, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);

    $pdo->exec('PRAGMA journal_mode=WAL;');
    $pdo->exec('PRAGMA foreign_keys=ON;');

    _init_schema($pdo);

    return $pdo;
}

function _init_schema(PDO $pdo): void
{
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS users (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            email      TEXT UNIQUE,
            phone      TEXT,
            created_at DATETIME DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS devices (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
            mac_address TEXT UNIQUE NOT NULL COLLATE NOCASE,
            hostname    TEXT,
            last_seen   DATETIME,
            created_at  DATETIME DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS vouchers (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            code             TEXT UNIQUE NOT NULL COLLATE NOCASE,
            site_id          TEXT NOT NULL DEFAULT 'default',
            ssid             TEXT,          -- NULL = any SSID allowed
            duration_minutes INTEGER NOT NULL DEFAULT 480,
            quota_mb         INTEGER,       -- NULL = unlimited
            max_uses         INTEGER NOT NULL DEFAULT 1,
            used_count       INTEGER NOT NULL DEFAULT 0,
            is_active        INTEGER NOT NULL DEFAULT 1,
            unifi_voucher_id TEXT,          -- ID returned by UniFi after sync
            note             TEXT,
            created_at       DATETIME DEFAULT (datetime('now')),
            expires_at       DATETIME
        );

        CREATE TABLE IF NOT EXISTS usages (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            voucher_id    INTEGER REFERENCES vouchers(id),
            user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
            device_id     INTEGER REFERENCES devices(id) ON DELETE SET NULL,
            mac_address   TEXT NOT NULL COLLATE NOCASE,
            ssid          TEXT,
            site_id       TEXT,
            authorized_at DATETIME DEFAULT (datetime('now')),
            expires_at    DATETIME,
            verified      INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS chat_sessions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT UNIQUE NOT NULL,
            webhook_url TEXT,
            messages    TEXT NOT NULL DEFAULT '[]',
            created_at  DATETIME DEFAULT (datetime('now')),
            updated_at  DATETIME DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_devices_mac   ON devices  (mac_address);
        CREATE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers (code);
        CREATE INDEX IF NOT EXISTS idx_usages_mac    ON usages   (mac_address);
    ");
}
