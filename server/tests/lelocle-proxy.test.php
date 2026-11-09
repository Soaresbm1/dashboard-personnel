<?php

declare(strict_types=1);
require $argv[1];

function verifyLeLocle(bool $condition, string $name): void { if (!$condition) throw new RuntimeException('test_failed: '.$name); }
$owned = [];
function leLocleTestDirectory(): string {
    global $owned;
    $path = sys_get_temp_dir().'/dashboard-lelocle-test-'.bin2hex(random_bytes(8));
    $owned[] = $path;
    return $path;
}
function leLocleCalendar(string $name = 'FC Le Locle - Juniors A', string $events = ''): string {
    return "BEGIN:VCALENDAR\r\r\nVERSION:2.0\r\r\nPRODID:FOOTBALL.CH\r\r\nX-WR-CALNAME:".$name."\r\r\n".$events."END:VCALENDAR\r\r\n";
}
function expectUnavailable(callable $callback, string $name): void {
    try { $callback(); } catch (RuntimeException $error) { verifyLeLocle($error->getMessage() === 'calendar_unavailable', $name); return; }
    throw new RuntimeException('test_failed: '.$name);
}
$now = 1800000000.0;
$clock = static function () use (&$now): float { return $now; };
try {
    $empty = leLocleCalendar();
    verifyLeLocle(DashboardLeLocleFixtures::validateCalendar($empty) === $empty, 'valid empty official calendar');
    $folded = str_replace('FC Le Locle - Juniors A', "FC Le Locle -\r\r\n  Juniors A", $empty);
    verifyLeLocle(DashboardLeLocleFixtures::validateCalendar($folded) === $folded, 'unfold calendar name');
    $event = "BEGIN:VEVENT\r\nUID:fixture@example.test\r\nDTSTART:20300101T120000Z\r\nSUMMARY:FC Le Locle - Fixture\r\nEND:VEVENT\r\n";
    verifyLeLocle(DashboardLeLocleFixtures::validateCalendar(leLocleCalendar(events: $event)) !== '', 'valid event');
    foreach (['', '<html>access denied</html>', leLocleCalendar('Other team'), "BEGIN:VCALENDAR\nEND:VCALENDAR",
        leLocleCalendar(events: "BEGIN:VEVENT\r\n"), leLocleCalendar().'<html>error</html>',
        str_replace('X-WR-CALNAME:', 'X-WR-CALNAME:Other' . "\n" . 'X-WR-CALNAME:', $empty),
        $empty.str_repeat('x', DashboardLeLocleFixtures::MAX_BYTES), $empty."\0", str_replace('VERSION:2.0', "VERSION:2.0\x01", $empty)] as $invalid) {
        expectUnavailable(static fn () => DashboardLeLocleFixtures::validateCalendar($invalid), 'reject invalid calendar');
    }

    $calls = 0; $mode = 'good'; $dir = leLocleTestDirectory();
    $request = static function (string $url) use (&$calls, &$mode, $empty): array {
        verifyLeLocle($url === DashboardLeLocleFixtures::SOURCE, 'fixed source'); $calls++;
        return match ($mode) {
            'good' => ['status' => 200, 'body' => $empty],
            'changed' => ['status' => 200, 'body' => leLocleCalendar(events: "BEGIN:VEVENT\nUID:changed\nEND:VEVENT\n")],
            'wrong-team' => ['status' => 200, 'body' => leLocleCalendar('Other team')],
            'html' => ['status' => 200, 'body' => '<html>error</html>'],
            'large' => ['status' => 200, 'body' => str_repeat('x', DashboardLeLocleFixtures::MAX_BYTES + 1)],
            'redirect' => ['status' => 302, 'body' => $empty],
            'http503' => ['status' => 503, 'body' => $empty],
            default => throw new RuntimeException('timeout/private error must not escape'),
        };
    };
    $service = new DashboardLeLocleFixtures($dir, $request, $clock);
    $first = $service->snapshot();
    verifyLeLocle($first['teamId'] === '34107' && !$first['checkFailed'] && $first['calendar'] === $empty, 'first valid sample');
    verifyLeLocle(array_keys($first) === ['schemaVersion','teamId','checkedAt','calendar','checkFailed'], 'public response shape');
    $now += 899; verifyLeLocle($service->snapshot() === $first && $calls === 1, 'cache interval');
    $now += 1; $boundary = $service->snapshot();
    verifyLeLocle($calls === 2 && $boundary['checkedAt'] !== $first['checkedAt'], 'refresh at exactly 900 seconds');
    $first = $boundary;
    foreach (['network', 'html', 'wrong-team', 'large', 'redirect', 'http503'] as $failure) {
        $now += 900; $mode = $failure; $before = $calls;
        $kept = $service->snapshot();
        verifyLeLocle($kept['checkFailed'] && $kept['checkedAt'] === $first['checkedAt'] && $kept['calendar'] === $first['calendar'], 'retain valid data on '.$failure);
        verifyLeLocle($calls === $before + 1, 'one failed request');
        $reloaded = new DashboardLeLocleFixtures($dir, $request, $clock);
        verifyLeLocle($reloaded->snapshot() === $kept && $calls === $before + 1, 'failure cache survives reload');
    }
    $now += 900; $mode = 'changed'; $recovered = $service->snapshot();
    verifyLeLocle(!$recovered['checkFailed'] && $recovered['checkedAt'] !== $first['checkedAt'] && str_contains($recovered['calendar'], 'UID:changed'), 'recovery replaces sample');
    $now += 900;
    $held = fopen($dir.'/check.lock', 'c'); flock($held, LOCK_EX); $before = $calls;
    try {
        $busy = $service->snapshot();
        verifyLeLocle($busy['checkFailed'] && $busy['checkedAt'] === $recovered['checkedAt'] && $calls === $before, 'nonblocking cache lock');
    } finally { flock($held, LOCK_UN); fclose($held); }

    $missingCalls = 0; $missingDir = leLocleTestDirectory();
    $missing = new DashboardLeLocleFixtures($missingDir, static function () use (&$missingCalls): array { $missingCalls++; throw new RuntimeException('private error'); }, $clock);
    expectUnavailable(static fn () => $missing->snapshot(), 'first failure unavailable');
    expectUnavailable(static fn () => $missing->snapshot(), 'first failure throttled');
    verifyLeLocle($missingCalls === 1, 'first failure request bound');
    $invalidDir = leLocleTestDirectory(); mkdir($invalidDir, 0700);
    file_put_contents($invalidDir.'/state.json', '{"attemptAt":0,"failed":false,"sample":{"schemaVersion":1,"teamId":"wrong"}}');
    $invalid = new DashboardLeLocleFixtures($invalidDir, static fn (): array => ['status' => 200, 'body' => $empty], $clock);
    verifyLeLocle(!$invalid->snapshot()['checkFailed'], 'corrupt cache replaced');

    foreach (['GET'=>200,'OPTIONS'=>204,'POST'=>405,'HEAD'=>405,'PUT'=>405] as $method=>$status) {
        $policy = DashboardLeLocleFixtures::httpPolicy($method, 'https://soaresbm1.github.io');
        verifyLeLocle($policy['status'] === $status && $policy['headers']['Access-Control-Allow-Origin'] === 'https://soaresbm1.github.io', 'method and CORS '.$method);
        verifyLeLocle(!isset($policy['headers']['Access-Control-Allow-Credentials']), 'no credentialed CORS');
    }
    verifyLeLocle(DashboardLeLocleFixtures::httpPolicy('GET', '')['status'] === 200, 'anonymous direct read');
    verifyLeLocle(DashboardLeLocleFixtures::httpPolicy('GET', 'https://evil.test')['status'] === 403, 'reject foreign origin');
    echo "LELOCLE_PROXY_TESTS_PASSED\n";
} finally {
    foreach ($owned as $dir) {
        $resolved = realpath($dir);
        $temporary = realpath(sys_get_temp_dir());
        if ($resolved === false) continue;
        if ($temporary === false || dirname($resolved) !== $temporary || !str_starts_with(basename($resolved), 'dashboard-lelocle-test-')) throw new RuntimeException('test_cleanup_boundary_failed');
        foreach (['state.json','check.lock'] as $name) if (is_file($resolved.'/'.$name)) unlink($resolved.'/'.$name);
        rmdir($resolved);
    }
}
