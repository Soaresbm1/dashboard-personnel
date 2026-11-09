<?php

declare(strict_types=1);

/** Public team-calendar proxy. No Laravel boot, account data, credentials or caller-selected URLs. */
final class DashboardLeLocleFixtures
{
    public const SOURCE = 'https://matchcenter-anf.football.ch/portaldata/1/nisrd/WebService/verein/calendar.asmx/Team?v=919&t=34107&sp=fr&calName=FC%20Le%20Locle%20-%20Juniors%20A&format=ics';
    public const TEAM_ID = '34107';
    public const CALENDAR_NAME = 'FC Le Locle - Juniors A';
    public const INTERVAL = 900;
    public const MAX_BYTES = 524288;
    private Closure $request;
    private Closure $clock;

    public function __construct(private string $directory, ?callable $request = null, ?callable $clock = null)
    {
        $this->request = $request ? Closure::fromCallable($request) : self::requestCalendar(...);
        $this->clock = $clock ? Closure::fromCallable($clock) : static fn (): float => microtime(true);
    }

    public function snapshot(): array
    {
        if (is_link($this->directory) || (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory))) {
            throw new RuntimeException('calendar_unavailable');
        }
        if (is_link($this->directory.'/check.lock')) throw new RuntimeException('calendar_unavailable');
        $lock = @fopen($this->directory.'/check.lock', 'c');
        if ($lock === false) throw new RuntimeException('calendar_unavailable');
        @chmod($this->directory.'/check.lock', 0600);
        try {
            if (!flock($lock, LOCK_EX | LOCK_NB)) return $this->reply($this->read(), true);
            $state = $this->read();
            $now = ($this->clock)();
            if (isset($state['attemptAt']) && $now >= $state['attemptAt'] && $now - $state['attemptAt'] < self::INTERVAL) {
                return $this->reply($state, $state['failed']);
            }
            // Persist the attempt before network I/O; failures and concurrent callers remain bounded.
            $state = ['attemptAt' => $now, 'failed' => true, 'sample' => $state['sample'] ?? null];
            $this->write($state);
            try {
                $response = ($this->request)(self::SOURCE);
                if (!is_array($response) || ($response['status'] ?? null) !== 200 || !is_string($response['body'] ?? null)) {
                    throw new RuntimeException('calendar_unavailable');
                }
                $calendar = self::validateCalendar($response['body']);
                $state['sample'] = ['schemaVersion' => 1, 'teamId' => self::TEAM_ID,
                    'checkedAt' => gmdate('Y-m-d\TH:i:s\Z', (int) ($this->clock)()), 'calendar' => $calendar];
                $state['failed'] = false;
            } catch (Throwable) {
                // Only a validated calendar can replace the last successful source sample.
            }
            $this->write($state);
            return $this->reply($state, $state['failed']);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    public static function validateCalendar(string $calendar): string
    {
        if ($calendar === '' || strlen($calendar) > self::MAX_BYTES || preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $calendar) || preg_match('//u', $calendar) !== 1) {
            throw new RuntimeException('calendar_unavailable');
        }
        // The official service currently emits CRCRLF. Normalize before RFC5545 unfolding.
        $normalized = preg_replace('/\r+\n/', "\n", $calendar);
        $normalized = str_replace("\r", "\n", $normalized ?? '');
        $normalized = preg_replace('/\n[ \t]/', '', trim($normalized));
        if (!is_string($normalized) || !str_starts_with($normalized, "BEGIN:VCALENDAR\n") || !str_ends_with($normalized, "\nEND:VCALENDAR")) {
            throw new RuntimeException('calendar_unavailable');
        }
        $stack = []; $names = [];
        foreach (explode("\n", $normalized) as $line) {
            if (str_starts_with($line, 'BEGIN:')) {
                $component = substr($line, 6);
                if (!preg_match('/^[A-Z][A-Z0-9-]*$/', $component) || ($component === 'VCALENDAR' && $stack !== [])) throw new RuntimeException('calendar_unavailable');
                $stack[] = $component;
            } elseif (str_starts_with($line, 'END:')) {
                if (array_pop($stack) !== substr($line, 4)) throw new RuntimeException('calendar_unavailable');
            } elseif (preg_match('/^X-WR-CALNAME:(.*)$/i', $line, $match)) {
                if ($stack !== ['VCALENDAR']) throw new RuntimeException('calendar_unavailable');
                $names[] = $match[1];
            }
        }
        if ($stack !== [] || $names !== [self::CALENDAR_NAME]) throw new RuntimeException('calendar_unavailable');
        return $calendar;
    }

    public static function httpPolicy(string $method, string $origin): array
    {
        $headers = ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store, no-cache, must-revalidate',
            'X-Content-Type-Options' => 'nosniff', 'Vary' => 'Origin', 'Access-Control-Allow-Methods' => 'GET, OPTIONS'];
        if ($origin !== '' && $origin !== 'https://soaresbm1.github.io') return ['status' => 403, 'headers' => $headers, 'error' => 'origin_not_allowed'];
        if ($origin !== '') $headers['Access-Control-Allow-Origin'] = 'https://soaresbm1.github.io';
        if ($method === 'OPTIONS') return ['status' => 204, 'headers' => $headers];
        if ($method !== 'GET') return ['status' => 405, 'headers' => [...$headers, 'Allow' => 'GET, OPTIONS'], 'error' => 'method_not_allowed'];
        return ['status' => 200, 'headers' => $headers];
    }

    private static function requestCalendar(string $url): array
    {
        if ($url !== self::SOURCE || !function_exists('curl_init')) throw new RuntimeException('calendar_unavailable');
        $curl = curl_init(self::SOURCE);
        if ($curl === false) throw new RuntimeException('calendar_unavailable');
        $body = ''; $tooLarge = false;
        curl_setopt_array($curl, [CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT_MS => 3000, CURLOPT_TIMEOUT_MS => 8000,
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_MAXFILESIZE => self::MAX_BYTES,
            CURLOPT_ENCODING => '', CURLOPT_HTTPHEADER => ['Accept: text/calendar'],
            CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$body, &$tooLarge): int {
                if (strlen($body) + strlen($chunk) > self::MAX_BYTES) { $tooLarge = true; return 0; }
                $body .= $chunk; return strlen($chunk);
            }]);
        curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $error = curl_errno($curl);
        curl_close($curl);
        if ($error !== 0 || $tooLarge) throw new RuntimeException('calendar_unavailable');
        return ['status' => $status, 'body' => $body];
    }

    private function read(): array
    {
        $path = $this->directory.'/state.json';
        if (!is_file($path) || is_link($path)) return [];
        $raw = @file_get_contents($path, false, null, 0, 2097153);
        if ($raw === false || strlen($raw) > 2097152) return [];
        $state = json_decode($raw, true);
        if (!is_array($state) || (!is_int($state['attemptAt'] ?? null) && !is_float($state['attemptAt'] ?? null)) || !is_finite((float) $state['attemptAt']) || !is_bool($state['failed'] ?? null)) return [];
        $sample = $state['sample'] ?? null;
        if ($sample !== null) {
            if (!is_array($sample) || ($sample['schemaVersion'] ?? null) !== 1 || ($sample['teamId'] ?? '') !== self::TEAM_ID
                || !is_string($sample['checkedAt'] ?? null) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', $sample['checkedAt'])
                || strtotime($sample['checkedAt']) === false || gmdate('Y-m-d\TH:i:s\Z', strtotime($sample['checkedAt'])) !== $sample['checkedAt'] || !is_string($sample['calendar'] ?? null)) return [];
            try { self::validateCalendar($sample['calendar']); } catch (Throwable) { return []; }
        }
        return ['attemptAt' => $state['attemptAt'], 'failed' => $state['failed'], 'sample' => $sample];
    }

    private function write(array $state): void
    {
        $pending = $this->directory.'/state-'.bin2hex(random_bytes(6)).'.tmp';
        try {
            $json = json_encode($state, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
            if (@file_put_contents($pending, $json, LOCK_EX) !== strlen($json)) throw new RuntimeException('calendar_unavailable');
            @chmod($pending, 0600);
            if (!@rename($pending, $this->directory.'/state.json')) throw new RuntimeException('calendar_unavailable');
        } finally { if (is_file($pending)) @unlink($pending); }
    }

    private function reply(array $state, bool $failed): array
    {
        if (!is_array($state['sample'] ?? null)) throw new RuntimeException('calendar_unavailable');
        return [...$state['sample'], 'checkFailed' => $failed];
    }
}

function dashboardLeLocleRespond(): void
{
    ini_set('display_errors', '0');
    $policy = DashboardLeLocleFixtures::httpPolicy($_SERVER['REQUEST_METHOD'] ?? '', $_SERVER['HTTP_ORIGIN'] ?? '');
    foreach ($policy['headers'] as $name => $value) header($name.': '.$value);
    http_response_code($policy['status']);
    if ($policy['status'] !== 200) {
        if (isset($policy['error'])) echo json_encode(['error' => $policy['error']]);
        return;
    }
    try {
        $service = new DashboardLeLocleFixtures(dirname(__DIR__).'/storage/app/private/dashboard-lelocle');
        echo json_encode($service->snapshot(), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    } catch (Throwable) {
        http_response_code(503);
        echo '{"error":"calendar_unavailable"}';
    }
}

// Including this file from the isolated CLI tests/installer defines only the service.
if (PHP_SAPI !== 'cli' || realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) dashboardLeLocleRespond();
