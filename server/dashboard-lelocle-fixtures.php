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

/** Independently cached, sanitized completed team results. */
final class DashboardLeLocleResults
{
    public const SOURCE = 'https://matchcenter-anf.football.ch/default.aspx?a=pt&lng=2&oid=15&t=34107&v=919';
    public const DETAILS_URL = 'https://matchcenter-anf.football.ch/default.aspx?a=pt&lng=2&oid=15&t=34107&v=919';
    public const INTERVAL = 900;
    public const MAX_BYTES = 1048576;
    private Closure $request;
    private Closure $clock;

    public function __construct(private string $directory, ?callable $request = null, ?callable $clock = null)
    {
        $this->request = $request ? Closure::fromCallable($request) : self::requestResults(...);
        $this->clock = $clock ? Closure::fromCallable($clock) : static fn (): float => microtime(true);
    }

    public function snapshot(): array
    {
        if (is_link($this->directory) || (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory))) return self::unavailable();
        if (is_link($this->directory.'/check.lock')) return self::unavailable();
        $lock = @fopen($this->directory.'/check.lock', 'c');
        if ($lock === false) return self::unavailable();
        @chmod($this->directory.'/check.lock', 0600);
        try {
            if (!flock($lock, LOCK_EX | LOCK_NB)) return $this->reply($this->read(), true);
            $state = $this->read(); $now = ($this->clock)();
            if (isset($state['attemptAt']) && $now >= $state['attemptAt'] && $now - $state['attemptAt'] < self::INTERVAL) return $this->reply($state, $state['failed']);
            $state = ['attemptAt'=>$now, 'failed'=>true, 'sample'=>$state['sample'] ?? null];
            $this->write($state);
            try {
                $response = ($this->request)(self::SOURCE);
                if (!is_array($response) || ($response['status'] ?? null) !== 200 || !is_string($response['body'] ?? null)) throw new RuntimeException('results_unavailable');
                $results = self::parseResults($response['body'], $now);
                $state['sample'] = ['checkedAt'=>gmdate('Y-m-d\TH:i:s\Z', (int) ($this->clock)()), 'results'=>$results];
                $state['failed'] = false;
            } catch (Throwable) { /* A source failure does not replace an observed score or its date. */ }
            $this->write($state);
            return $this->reply($state, $state['failed']);
        } catch (Throwable) {
            return $this->reply($this->read(), true);
        } finally {
            flock($lock, LOCK_UN); fclose($lock);
        }
    }

    /** Seed only a human/browser-verified public source capture, preserving newer observations. */
    public function seedFromVerifiedHtml(string $html, float $capturedAt): array
    {
        if (!is_finite($capturedAt) || $capturedAt < 946684800 || $capturedAt > ($this->clock)() + 60) throw new RuntimeException('invalid_results_capture');
        $results = self::parseResults($html, $capturedAt);
        if (is_link($this->directory) || (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory))) throw new RuntimeException('results_unavailable');
        if (is_link($this->directory.'/check.lock')) throw new RuntimeException('results_unavailable');
        $lock = @fopen($this->directory.'/check.lock', 'c');
        if ($lock === false) throw new RuntimeException('results_unavailable');
        @chmod($this->directory.'/check.lock', 0600);
        try {
            if (!flock($lock, LOCK_EX | LOCK_NB)) return $this->reply($this->read(), true);
            $state = $this->read();
            if (isset($state['sample']['checkedAt']) && strtotime($state['sample']['checkedAt']) >= (int)$capturedAt) return $this->reply($state, $state['failed']);
            $sample = ['checkedAt'=>gmdate('Y-m-d\TH:i:s\Z', (int)$capturedAt), 'results'=>$results];
            $state = ['attemptAt'=>$state['attemptAt'] ?? 0.0, 'failed'=>true, 'sample'=>$sample];
            $this->write($state);
            return $this->reply($state, true);
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    public static function parseResults(string $html, float $now): array
    {
        if ($html === '' || strlen($html) > self::MAX_BYTES || preg_match('//u', $html) !== 1 || !class_exists(DOMDocument::class)) throw new RuntimeException('results_unavailable');
        $document = new DOMDocument(); $prior = libxml_use_internal_errors(true);
        try {
            if (!$document->loadHTML('<?xml encoding="UTF-8" ?>'.$html, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING)) throw new RuntimeException('results_unavailable');
        } finally { libxml_clear_errors(); libxml_use_internal_errors($prior); }
        $xpath = new DOMXPath($document);
        $heading = $xpath->query('//*[@id="ddmTeam"]');
        if ($heading === false || $heading->length !== 1 || !preg_match('/(?:E|É)quipe\s*[-–]\s*Juniors A\b/u', self::text($heading->item(0)))) throw new RuntimeException('results_unavailable');
        $lists = $xpath->query('//*[contains(concat(" ",normalize-space(@class)," ")," nisListeRD ") and substring(@id,string-length(@id)-11)="_tbResultate"]');
        if ($lists === false || $lists->length !== 1) throw new RuntimeException('results_unavailable');
        $list = $lists->item(0); $league = 'Juniors A'; $results = []; $seen = [];
        foreach ($list->childNodes as $item) {
            if (!$item instanceof DOMElement) continue;
            if (self::hasClass($item, 'sppTitel')) { $league = self::text($item) ?: 'Juniors A'; continue; }
            $rows = $xpath->query('.//*[contains(concat(" ",normalize-space(@class)," ")," spiel ")]', $item);
            if ($rows === false || $rows->length === 0) continue;
            if ($rows->length !== 1) throw new RuntimeException('results_unavailable');
            $row = $rows->item(0);
            $homes = self::nodes($xpath, $row, 'teamA'); $aways = self::nodes($xpath, $row, 'teamB');
            if (count($homes) !== 1 || count($aways) !== 1) throw new RuntimeException('results_unavailable');
            $home = self::text($homes[0]); $away = self::text($aways[0]);
            if (!$home || !$away || strlen($home)>640 || strlen($away)>640 || (int) self::owner($home) + (int) self::owner($away) !== 1) throw new RuntimeException('results_unavailable');
            $scoresA = self::nodes($xpath, $row, 'torA'); $scoresB = self::nodes($xpath, $row, 'torB');
            if ($scoresA === [] && $scoresB === []) {
                $goals = self::nodes($xpath, $row, 'goals');
                if (count($goals) !== 1 || preg_match('/\d/', self::text($goals[0]))) throw new RuntimeException('results_unavailable');
                continue;
            }
            if (count($scoresA) !== 1 || count($scoresB) !== 1) throw new RuntimeException('results_unavailable');
            $scoreHome = self::text($scoresA[0]); $scoreAway = self::text($scoresB[0]);
            // Empty/dash/live-state cells are not a published 0-0 result.
            if (!preg_match('/^\d{1,2}$/', $scoreHome) || !preg_match('/^\d{1,2}$/', $scoreAway)) continue;
            if (preg_match('/(?<!\p{L})(?:annul[ée]e?|renvoy[ée]e?|report[ée]e?|abandonn[ée]e?|interrompue?|live|en cours)(?!\p{L})/iu', self::text($row))) continue;
            $dates = self::nodes($xpath, $row, 'date');
            if (count($dates) !== 1 || !preg_match('/\b(\d{2})\.(\d{2})\.(\d{4})(?:\s*(\d{2}):(\d{2}))?/u', self::text($dates[0]), $date) || (int)$date[3]<2000 || (int)$date[3]>2100) throw new RuntimeException('results_unavailable');
            $hasTime = isset($date[4]) && ($date[4] !== '00' || $date[5] !== '00');
            $local = sprintf('%s-%s-%s %s:%s', $date[3], $date[2], $date[1], $hasTime ? $date[4] : '12', $hasTime ? $date[5] : '00');
            $when = DateTimeImmutable::createFromFormat('!Y-m-d H:i', $local, new DateTimeZone('Europe/Zurich'));
            if (!$when || $when->format('Y-m-d H:i') !== $local) throw new RuntimeException('results_unavailable');
            // The table has no verified final-state field. A generous completion window
            // excludes today's live scores; date-only results are accepted from past days.
            if ($hasTime ? $when->getTimestamp() > $now - 3 * 3600 : $when->format('Y-m-d') >= (new DateTimeImmutable('@'.(int)$now))->setTimezone(new DateTimeZone('Europe/Zurich'))->format('Y-m-d')) continue;
            $links = $xpath->query('.//a[@href]', $row); $id = null;
            foreach ($links ?: [] as $link) {
                $url = parse_url($link->getAttribute('href')); $query = [];
                parse_str($url['query'] ?? '', $query);
                if (($query['v'] ?? null) === '919' && ($query['t'] ?? null) === '34107' && is_string($query['tg'] ?? null) && preg_match('/^\d{1,30}$/', $query['tg'])) { $id = $query['tg']; break; }
            }
            if ($id === null) {
                if (!preg_match('/N°\s*match\s*(\d{1,30})/u', self::text($row), $number)) throw new RuntimeException('results_unavailable');
                $id = $number[1];
            }
            if (isset($seen[$id])) continue;
            $seen[$id] = true;
            $results[] = ['id'=>$id, 'home'=>$home, 'away'=>$away, 'startsAt'=>$when->format('Y-m-d\TH:i:sP'), 'timeConfirmed'=>$hasTime,
                'scoreHome'=>(int)$scoreHome, 'scoreAway'=>(int)$scoreAway, 'league'=>$league, 'url'=>self::DETAILS_URL];
        }
        usort($results, static fn (array $a, array $b): int => strtotime($b['startsAt']) <=> strtotime($a['startsAt']) ?: strcmp($b['id'], $a['id']));
        return array_slice($results, 0, 3);
    }

    private static function text(?DOMNode $node): string { return trim(preg_replace('/\s+/u', ' ', str_replace("\u{00A0}", ' ', $node?->textContent ?? '')) ?? ''); }
    private static function hasClass(DOMElement $node, string $class): bool { return in_array($class, preg_split('/\s+/', $node->getAttribute('class')) ?: [], true); }
    private static function nodes(DOMXPath $xpath, DOMNode $context, string $class): array { return iterator_to_array($xpath->query('.//*[contains(concat(" ",normalize-space(@class)," ")," '.$class.' ")]', $context) ?: []); }
    private static function owner(string $value): bool { return preg_match('/^FC Le Locle(?:\s*\(Jun\.?\s*A\))?$/iu', $value) === 1; }

    private static function requestResults(string $url): array
    {
        if ($url !== self::SOURCE || !function_exists('curl_init')) throw new RuntimeException('results_unavailable');
        $curl = curl_init(self::SOURCE); if ($curl === false) throw new RuntimeException('results_unavailable');
        $body = ''; $tooLarge = false;
        curl_setopt_array($curl, [CURLOPT_FOLLOWLOCATION=>false, CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS, CURLOPT_CONNECTTIMEOUT_MS=>3000, CURLOPT_TIMEOUT_MS=>8000,
            CURLOPT_SSL_VERIFYPEER=>true, CURLOPT_SSL_VERIFYHOST=>2, CURLOPT_MAXFILESIZE=>self::MAX_BYTES, CURLOPT_ENCODING=>'',
            CURLOPT_HTTPHEADER=>['Accept: text/html'], CURLOPT_USERAGENT=>'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            CURLOPT_WRITEFUNCTION=>static function ($curl, string $chunk) use (&$body, &$tooLarge): int { if (strlen($body)+strlen($chunk)>self::MAX_BYTES) { $tooLarge=true; return 0; } $body.=$chunk; return strlen($chunk); }]);
        curl_exec($curl); $status=(int)curl_getinfo($curl,CURLINFO_RESPONSE_CODE); $error=curl_errno($curl); curl_close($curl);
        if ($error!==0 || $tooLarge) throw new RuntimeException('results_unavailable');
        return ['status'=>$status,'body'=>$body];
    }

    private static function unavailable(): array { return ['resultsState'=>'unavailable','results'=>[],'resultsCheckedAt'=>null,'resultsCheckFailed'=>true]; }
    private function reply(array $state, bool $failed): array
    {
        if (!is_array($state['sample'] ?? null)) return self::unavailable();
        return ['resultsState'=>'ready','results'=>$state['sample']['results'],'resultsCheckedAt'=>$state['sample']['checkedAt'],'resultsCheckFailed'=>$failed];
    }
    private function read(): array
    {
        $path=$this->directory.'/state.json'; if (!is_file($path) || is_link($path)) return [];
        $raw=@file_get_contents($path,false,null,0,65537); if ($raw===false || strlen($raw)>65536) return [];
        $state=json_decode($raw,true);
        if (!is_array($state) || !is_numeric($state['attemptAt'] ?? null) || !is_finite((float)$state['attemptAt']) || !is_bool($state['failed'] ?? null)) return [];
        $sample=$state['sample'] ?? null;
        if ($sample!==null) {
            if (!is_array($sample) || !is_string($sample['checkedAt'] ?? null) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/',$sample['checkedAt']) || strtotime($sample['checkedAt'])===false
                || gmdate('Y-m-d\TH:i:s\Z',strtotime($sample['checkedAt']))!==$sample['checkedAt'] || !is_array($sample['results'] ?? null) || count($sample['results'])>3) return [];
            $seen=[];
            foreach ($sample['results'] as $row) {
                if (!is_array($row) || !is_string($row['id'] ?? null) || !preg_match('/^\d{1,30}$/',$row['id']) || isset($seen[$row['id']])
                    || !is_string($row['home'] ?? null) || !is_string($row['away'] ?? null) || (int)self::owner($row['home'])+(int)self::owner($row['away'])!==1
                    || !is_string($row['startsAt'] ?? null) || strtotime($row['startsAt'])===false || !is_bool($row['timeConfirmed'] ?? null)
                    || !is_int($row['scoreHome'] ?? null) || $row['scoreHome']<0 || $row['scoreHome']>99 || !is_int($row['scoreAway'] ?? null) || $row['scoreAway']<0 || $row['scoreAway']>99
                    || !is_string($row['league'] ?? null) || ($row['url'] ?? null)!==self::DETAILS_URL) return [];
                $seen[$row['id']]=true;
            }
        }
        return ['attemptAt'=>(float)$state['attemptAt'],'failed'=>$state['failed'],'sample'=>$sample];
    }
    private function write(array $state): void
    {
        $pending=$this->directory.'/state-'.bin2hex(random_bytes(6)).'.tmp';
        try {
            $json=json_encode($state,JSON_THROW_ON_ERROR|JSON_UNESCAPED_SLASHES);
            if (@file_put_contents($pending,$json,LOCK_EX)!==strlen($json)) throw new RuntimeException('results_unavailable');
            @chmod($pending,0600); if (!@rename($pending,$this->directory.'/state.json')) throw new RuntimeException('results_unavailable');
        } finally { if (is_file($pending)) @unlink($pending); }
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
        $calendar = $service->snapshot();
        $results = new DashboardLeLocleResults(dirname(__DIR__).'/storage/app/private/dashboard-lelocle/results');
        echo json_encode([...$calendar, ...$results->snapshot()], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    } catch (Throwable) {
        http_response_code(503);
        echo '{"error":"calendar_unavailable"}';
    }
}

// Including this file from the isolated CLI tests/installer defines only the service.
if (PHP_SAPI !== 'cli' || realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) dashboardLeLocleRespond();
