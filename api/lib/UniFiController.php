<?php
/**
 * UniFi Controller API wrapper (UniFiOs / Network Application 7.x-10.x).
 *
 * Supports both legacy UniFi controllers (port 8443) and UniFiOs (port 443).
 * Authentication uses cookie-based sessions via cURL.
 */
class UniFiController
{
    private string $baseUrl;
    private string $username;
    private string $password;
    private string $defaultSite;
    private string $cookieFile;
    private bool   $loggedIn = false;
    private bool   $isUniFiOs;
    // Self-signed certificates are common in UniFi home setups.
    // Set $verifySsl = true in production when using a valid certificate.
    private bool   $verifySsl;

    public function __construct(
        string $host,
        int    $port,
        string $username,
        string $password,
        string $defaultSite = 'default',
        string $version     = '8',
        bool   $verifySsl   = false
    ) {
        $this->baseUrl     = rtrim($host, '/') . ':' . $port;
        $this->username    = $username;
        $this->password    = $password;
        $this->defaultSite = $defaultSite;
        $this->isUniFiOs   = ((int) $version >= 7);
        $this->verifySsl   = $verifySsl;
        $this->cookieFile  = sys_get_temp_dir() . '/unifi_cookie_' . md5($host . $port . $username) . '.txt';
    }

    // ─── Authentication ───────────────────────────────────────────────────────

    public function login(): bool
    {
        if ($this->loggedIn) {
            return true;
        }

        if ($this->isUniFiOs) {
            $url  = $this->baseUrl . '/api/auth/login';
        } else {
            $url  = $this->baseUrl . '/api/login';
        }

        $payload = json_encode([
            'username' => $this->username,
            'password' => $this->password,
        ]);

        $response = $this->request('POST', $url, $payload);

        if ($response['http_code'] === 200) {
            $this->loggedIn = true;
            return true;
        }

        throw new RuntimeException(
            'UniFi login failed (HTTP ' . $response['http_code'] . '): ' . $response['body']
        );
    }

    public function logout(): void
    {
        if (!$this->loggedIn) {
            return;
        }
        $url = $this->isUniFiOs
            ? $this->baseUrl . '/api/auth/logout'
            : $this->baseUrl . '/api/logout';
        $this->request('POST', $url, '{}');
        $this->loggedIn = false;
        @unlink($this->cookieFile);
    }

    // ─── Client / Station authorization ──────────────────────────────────────

    /**
     * Authorize a client MAC address on the given site.
     *
     * @param string   $mac        Client MAC (e.g. "aa:bb:cc:dd:ee:ff")
     * @param int      $minutes    Session duration in minutes (0 = unlimited)
     * @param int|null $upBps      Upload speed limit in bps (null = none)
     * @param int|null $downBps    Download speed limit in bps (null = none)
     * @param int|null $quotaMb    Traffic quota in MB (null = none)
     * @param string   $apMac      AP MAC address
     * @param string   $site       Site name (defaults to configured site)
     */
    public function authorizeClient(
        string $mac,
        int    $minutes = 480,
        ?int   $upBps   = null,
        ?int   $downBps = null,
        ?int   $quotaMb = null,
        string $apMac   = '',
        string $site    = ''
    ): array {
        $this->login();
        $site = $site ?: $this->defaultSite;

        $payload = [
            'cmd'     => 'authorize-guest',
            'mac'     => strtolower($mac),
            'minutes' => $minutes,
        ];
        if ($apMac)   $payload['ap_mac'] = strtolower($apMac);
        if ($upBps)   $payload['up']     = $upBps;
        if ($downBps) $payload['down']   = $downBps;
        if ($quotaMb) $payload['bytes']  = $quotaMb * 1024 * 1024;

        return $this->siteCmd($site, 'stamgr', $payload);
    }

    /**
     * Unauthorize (kick) a client from the network.
     */
    public function unauthorizeClient(string $mac, string $site = ''): array
    {
        $this->login();
        $site = $site ?: $this->defaultSite;
        return $this->siteCmd($site, 'stamgr', [
            'cmd' => 'unauthorize-guest',
            'mac' => strtolower($mac),
        ]);
    }

    /**
     * Check whether a MAC address is currently authorized (has an active session).
     */
    public function isAuthorized(string $mac, string $site = ''): bool
    {
        $this->login();
        $site    = $site ?: $this->defaultSite;
        $clients = $this->getAuthorizedClients($site);

        $mac = strtolower($mac);
        foreach ($clients as $client) {
            if (strtolower($client['mac'] ?? '') === $mac) {
                return true;
            }
        }
        return false;
    }

    /**
     * Return all currently authorized guest clients for a site.
     */
    public function getAuthorizedClients(string $site = ''): array
    {
        $this->login();
        $site = $site ?: $this->defaultSite;
        $url  = $this->siteUrl($site, 'stat/guest');
        $res  = $this->request('GET', $url);
        $data = json_decode($res['body'], true);
        return $data['data'] ?? [];
    }

    // ─── Vouchers ─────────────────────────────────────────────────────────────

    /**
     * Create vouchers in the UniFi controller and return their IDs / codes.
     *
     * @param int    $count    Number of vouchers to create
     * @param int    $minutes  Session duration
     * @param int    $maxUses  0 = single use, >1 = multi-use
     * @param int|null $quotaMb Traffic quota in MB
     * @param int|null $upKbps  Upload speed kbps
     * @param int|null $downKbps Download speed kbps
     * @param string $note     Internal note
     * @param string $site     Site name
     */
    public function createVouchers(
        int    $count     = 1,
        int    $minutes   = 480,
        int    $maxUses   = 1,
        ?int   $quotaMb   = null,
        ?int   $upKbps    = null,
        ?int   $downKbps  = null,
        string $note      = '',
        string $site      = ''
    ): array {
        $this->login();
        $site = $site ?: $this->defaultSite;

        $payload = [
            'cmd'     => 'create-voucher',
            'expire'  => $minutes,
            'n'       => $count,
            'quota'   => $maxUses === 1 ? 1 : $maxUses,
        ];
        if ($quotaMb)  $payload['bytes']  = $quotaMb;
        if ($upKbps)   $payload['up']     = $upKbps;
        if ($downKbps) $payload['down']   = $downKbps;
        if ($note)     $payload['note']   = $note;

        $result = $this->siteCmd($site, 'hotspot', $payload);

        if (empty($result['data'])) {
            return $result;
        }

        // Fetch the newly created vouchers by createTime
        $createTime = $result['data'][0]['create_time'] ?? null;
        if ($createTime) {
            return $this->getVouchers($site, $createTime);
        }
        return $result;
    }

    /**
     * Fetch vouchers from the controller, optionally filtered by create_time.
     */
    public function getVouchers(string $site = '', ?int $createTime = null): array
    {
        $this->login();
        $site = $site ?: $this->defaultSite;
        $url  = $this->siteUrl($site, 'stat/voucher');
        if ($createTime) {
            $url .= '?create_time=' . $createTime;
        }
        $res  = $this->request('GET', $url);
        $data = json_decode($res['body'], true);
        return $data['data'] ?? [];
    }

    /**
     * Delete a voucher by its UniFi-internal ID.
     */
    public function deleteVoucher(string $voucherId, string $site = ''): array
    {
        $this->login();
        $site = $site ?: $this->defaultSite;
        return $this->siteCmd($site, 'hotspot', [
            'cmd' => 'delete-voucher',
            '_id' => $voucherId,
        ]);
    }

    // ─── Sites ────────────────────────────────────────────────────────────────

    /**
     * List all sites on the controller.
     */
    public function listSites(): array
    {
        $this->login();
        $url = $this->baseUrl . '/api/self/sites';
        $res = $this->request('GET', $url);
        $data = json_decode($res['body'], true);
        return $data['data'] ?? [];
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    private function siteUrl(string $site, string $path): string
    {
        if ($this->isUniFiOs) {
            return $this->baseUrl . '/proxy/network/api/s/' . $site . '/' . $path;
        }
        return $this->baseUrl . ':8443/api/s/' . $site . '/' . $path;
    }

    private function siteCmd(string $site, string $manager, array $payload): array
    {
        $url  = $this->siteUrl($site, 'cmd/' . $manager);
        $res  = $this->request('POST', $url, json_encode($payload));
        $data = json_decode($res['body'], true);
        if ($res['http_code'] < 200 || $res['http_code'] >= 300) {
            throw new RuntimeException(
                'UniFi API error (HTTP ' . $res['http_code'] . '): ' . $res['body']
            );
        }
        return $data ?? [];
    }

    /**
     * Low-level cURL request with cookie persistence and CSRF token handling.
     *
     * @return array{http_code: int, body: string, headers: string}
     */
    private function request(string $method, string $url, string $body = ''): array
    {
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_SSL_VERIFYPEER => $this->verifySsl,
            CURLOPT_SSL_VERIFYHOST => $this->verifySsl ? 2 : 0,
            CURLOPT_COOKIEJAR      => $this->cookieFile,
            CURLOPT_COOKIEFILE     => $this->cookieFile,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_HEADER         => true,
        ]);

        $headers = ['Content-Type: application/json'];

        // Read CSRF token from cookie file if present
        $csrf = $this->readCsrfToken();
        if ($csrf) {
            $headers[] = 'X-Csrf-Token: ' . $csrf;
        }

        if ($method === 'POST') {
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        } elseif ($method !== 'GET') {
            curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
            if ($body) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
            }
        }

        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        $response  = curl_exec($ch);
        $httpCode  = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        curl_close($ch);

        if ($response === false) {
            throw new RuntimeException('cURL error: ' . curl_error($ch));
        }

        return [
            'http_code' => $httpCode,
            'headers'   => substr($response, 0, $headerSize),
            'body'      => substr($response, $headerSize),
        ];
    }

    private function readCsrfToken(): string
    {
        if (!file_exists($this->cookieFile)) {
            return '';
        }
        $content = file_get_contents($this->cookieFile);
        if (preg_match('/csrf_token\s+(\S+)/i', $content, $m)) {
            return $m[1];
        }
        // UniFiOs stores TOKEN cookie
        if (preg_match('/\sTOKEN\s+(\S+)/i', $content, $m)) {
            return $m[1];
        }
        return '';
    }
}
