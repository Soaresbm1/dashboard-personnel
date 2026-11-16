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
    verifyLeLocle(DashboardAnfTeams::select([]) === '34107', 'legacy default team retained');
    verifyLeLocle(array_column(DashboardAnfTeams::TEAMS, 'id') === ['34107','74009','68914'], 'only three approved team IDs');
    verifyLeLocle(DashboardAnfTeams::calendarSource() === DashboardLeLocleFixtures::SOURCE, 'legacy calendar source unchanged');
    verifyLeLocle(DashboardAnfTeams::get()['detailsUrl'] === DashboardLeLocleResults::DETAILS_URL, 'legacy result source unchanged');
    verifyLeLocle(DashboardAnfTeams::cacheDirectory('/app') === '/app/storage/app/private/dashboard-lelocle', 'legacy cache directory retained');
    foreach ([['team'=>'unknown'], ['team'=>['74009']], ['team'=>'74009','url'=>'https://evil.test'], ['url'=>'https://evil.test'], ['team'=>74009]] as $query) {
        $threw = false; try { DashboardAnfTeams::select($query); } catch (RuntimeException $error) { $threw = $error->getMessage() === 'team_not_allowed'; }
        verifyLeLocle($threw, 'invalid selector is not a URL source');
    }
    foreach (['74009','68914'] as $teamId) {
        $team = DashboardAnfTeams::get($teamId);
        verifyLeLocle(DashboardAnfTeams::select(['team'=>$teamId]) === $teamId, 'allow configured team selector');
        verifyLeLocle(DashboardAnfTeams::cacheDirectory('/app', $teamId) === '/app/storage/app/private/dashboard-anf/'.$teamId, 'isolated team cache directory');
        $teamCalendar = leLocleCalendar($team['calendarName']);
        verifyLeLocle(DashboardLeLocleFixtures::validateCalendar($teamCalendar, $teamId) === $teamCalendar, 'configured team calendar validated');
        expectUnavailable(static fn () => DashboardLeLocleFixtures::validateCalendar($empty, $teamId), 'foreign-team calendar rejected');
        $teamCalls = 0; $teamNow = $now; $teamMode = 'good';
        $teamClock = static function () use (&$teamNow): float { return $teamNow; };
        $teamRequest = static function (string $url) use (&$teamCalls, &$teamMode, $teamCalendar, $teamId): array {
            verifyLeLocle($url === DashboardAnfTeams::calendarSource($teamId), 'selected team source is fixed'); $teamCalls++;
            if ($teamMode === 'failed') throw new RuntimeException('unavailable');
            return ['status'=>200, 'body'=>$teamCalendar];
        };
        $teamDir = leLocleTestDirectory();
        $teamService = new DashboardLeLocleFixtures($teamDir, $teamRequest, $teamClock, $teamId);
        $teamFirst = $teamService->snapshot();
        verifyLeLocle($teamFirst['teamId'] === $teamId && $teamFirst['calendar'] === $teamCalendar && !$teamFirst['checkFailed'], 'selected team has its own response');
        $teamMode = 'failed'; $teamNow += 900; $teamFailed = $teamService->snapshot();
        verifyLeLocle($teamFailed['checkedAt'] === $teamFirst['checkedAt'] && $teamFailed['checkFailed'] && $teamCalls === 2, 'selected team failed refresh preserves date');
        $wrongSource = new DashboardLeLocleFixtures($teamDir, static fn (): array=>['status'=>200,'body'=>$empty], $teamClock);
        verifyLeLocle($wrongSource->snapshot()['teamId'] === '34107', 'calendar state from a different team cannot be reused');
    }
    // Synthetic fixture markup mirrors the observed official team calendar structure.
    function resultsRow(string $id, string $date, string $home, string $away, string $a = '2', string $b = '1', string $note = ''): string {
        return '<div class="list-group-item"><div class="row spiel"><div class="date"><span>'.$date.'</span>16:00</div>'
            .'<div class="teamA">'.htmlspecialchars($home, ENT_QUOTES|ENT_SUBSTITUTE, 'UTF-8').'</div><div class="teamB">'.htmlspecialchars($away, ENT_QUOTES|ENT_SUBSTITUTE, 'UTF-8').'</div>'
            .'<div class="goals"><div class="torA">'.$a.'</div><div class="torB">'.$b.'</div></div>'
            .'<div class="telegramm-link"><a href="/default.aspx?v=919&amp;t=34107&amp;tg='.$id.'">Details</a></div>'
            .'<div class="font-small">N° match '.$id.'</div><div>'.$note.'</div></div></div>';
    }
    function resultsPage(string $rows): string { return '<!doctype html><html><body><button id="ddmTeam">Equipe - Juniors A</button><div id="fixture_tbResultate" class="nisListeRD list-group"><div class="list-group-item sppTitel">championnat Juniors A</div>'.$rows.'</div></body></html>'; }
    $resultNow = (float)strtotime('2026-11-09T12:00:00Z');
    $resultClock = static function () use (&$resultNow): float { return $resultNow; };
    $resultHtml = resultsPage(resultsRow('1','Di 08.11.2026','Fixture A','FC Le Locle','0','1')
        .resultsRow('2','Di 01.11.2026','FC Le Locle','Fixture B','2','2')
        .resultsRow('3','Me 28.10.2026','Fixture C (Jun.A)','FC Le Locle (Jun.A)','4','3')
        .resultsRow('4','Di 25.10.2026','Fixture D','FC Le Locle','1','0')
        .resultsRow('5','Di 15.11.2026','FC Le Locle','Future opponent','1','0')
        .resultsRow('6','Lu 09.11.2026','FC Le Locle','Live opponent','1','0'));
    $parsedResults = DashboardLeLocleResults::parseResults($resultHtml, $resultNow);
    verifyLeLocle(array_column($parsedResults,'id') === ['1','2','3'], 'three latest settled past results');
    verifyLeLocle($parsedResults[0]['scoreHome'] === 0 && $parsedResults[0]['scoreAway'] === 1, 'real zero score is retained');
    verifyLeLocle($parsedResults[0]['startsAt'] === '2026-11-08T16:00:00+01:00' && $parsedResults[0]['url'] === DashboardLeLocleResults::DETAILS_URL, 'Swiss time and fixed link');
    verifyLeLocle(DashboardLeLocleResults::parseResults(resultsPage(''),$resultNow) === [], 'valid official empty results');
    $blank = resultsPage(resultsRow('7','Di 08.11.2026','FC Le Locle','Fixture','-',''));
    verifyLeLocle(DashboardLeLocleResults::parseResults($blank,$resultNow) === [], 'placeholder is not zero');
    verifyLeLocle(DashboardLeLocleResults::parseResults(resultsPage(resultsRow('7','Di 08.11.2026','FC Le Locle','Fixture','2','1','match annulé')),$resultNow) === [], 'cancelled excluded');
    foreach (['<html>access denied</html>', str_replace('Juniors A','Juniors B',$resultHtml), str_replace('FC Le Locle','Other club',$resultHtml),
        str_replace('nisListeRD','changed-layout',$resultHtml), str_repeat('x',DashboardLeLocleResults::MAX_BYTES+1)] as $invalidResults) {
        $threw=false; try { DashboardLeLocleResults::parseResults($invalidResults,$resultNow); } catch (RuntimeException) { $threw=true; }
        verifyLeLocle($threw,'reject unrecognized result source');
    }
    $resultCalls=0; $resultMode='good'; $resultDir=leLocleTestDirectory();
    $resultRequest=static function(string $url) use (&$resultCalls,&$resultMode,$resultHtml):array {
        verifyLeLocle($url===DashboardLeLocleResults::SOURCE,'fixed result source'); $resultCalls++;
        return match($resultMode) {
            'good'=>['status'=>200,'body'=>$resultHtml], 'empty'=>['status'=>200,'body'=>resultsPage('')],
            'html'=>['status'=>200,'body'=>'<html>error</html>'], '403'=>['status'=>403,'body'=>'access denied'],
            default=>throw new RuntimeException('private failure'),
        };
    };
    $resultsService=new DashboardLeLocleResults($resultDir,$resultRequest,$resultClock);
    $freshResults=$resultsService->snapshot();
    verifyLeLocle($freshResults['resultsState']==='ready' && count($freshResults['results'])===3 && !$freshResults['resultsCheckFailed'],'first observed results');
    $resultNow+=899; verifyLeLocle($resultsService->snapshot()===$freshResults && $resultCalls===1,'results cached independently');
    $resultNow+=1; $resultMode='403'; $retainedResults=$resultsService->snapshot();
    verifyLeLocle($retainedResults['resultsState']==='ready' && $retainedResults['resultsCheckFailed'] && $retainedResults['resultsCheckedAt']===$freshResults['resultsCheckedAt'] && $retainedResults['results']===$freshResults['results'],'source denial retains dated results');
    $reloadResults=new DashboardLeLocleResults($resultDir,$resultRequest,$resultClock);
    verifyLeLocle($reloadResults->snapshot()===$retainedResults && $resultCalls===2,'results retention survives service reload');
    $resultNow+=900; $resultMode='empty'; $emptyResults=$resultsService->snapshot();
    verifyLeLocle($emptyResults['resultsState']==='ready' && $emptyResults['results']===[] && !$emptyResults['resultsCheckFailed'] && $emptyResults['resultsCheckedAt']!==$freshResults['resultsCheckedAt'],'fresh official empty replaces old scores');
    $missingResultsDir=leLocleTestDirectory(); $missingResultCalls=0;
    $missingResults=new DashboardLeLocleResults($missingResultsDir,static function()use(&$missingResultCalls):array{$missingResultCalls++;return ['status'=>403,'body'=>'denied'];},$resultClock);
    $unavailableResults=$missingResults->snapshot();
    verifyLeLocle($unavailableResults===['resultsState'=>'unavailable','results'=>[],'resultsCheckedAt'=>null,'resultsCheckFailed'=>true],'unavailable is distinct from empty observation');
    verifyLeLocle($missingResults->snapshot()===$unavailableResults && $missingResultCalls===1,'unavailable result attempts bounded');
    $resultNow+=900; $heldResults=fopen($resultDir.'/check.lock','c');flock($heldResults,LOCK_EX);$beforeResults=$resultCalls;
    try { $busyResults=$resultsService->snapshot(); verifyLeLocle($busyResults['resultsCheckFailed'] && $busyResults['resultsCheckedAt']===$emptyResults['resultsCheckedAt'] && $resultCalls===$beforeResults,'result lock is nonblocking'); }
    finally {flock($heldResults,LOCK_UN);fclose($heldResults);}
    $seedDir=leLocleTestDirectory(); $seedCalls=0;
    $seedRequest=static function()use(&$seedCalls,$resultHtml):array{$seedCalls++;return ['status'=>403,'body'=>'denied'];};
    $seedService=new DashboardLeLocleResults($seedDir,$seedRequest,$resultClock);
    $captureAt=$resultNow-3600;
    $seeded=$seedService->seedFromVerifiedHtml($resultHtml,$captureAt);
    verifyLeLocle($seeded['resultsState']==='ready' && $seeded['resultsCheckFailed'] && $seeded['resultsCheckedAt']===gmdate('Y-m-d\TH:i:s\Z',(int)$captureAt) && count($seeded['results'])===3,'verified capture seeded with original time and stale flag');
    $seedDenied=$seedService->snapshot();
    verifyLeLocle($seedDenied===$seeded && $seedCalls===1,'HTTP403 retains verified seeded scores without retimestamping');
    $older=$seedService->seedFromVerifiedHtml(resultsPage(''),$captureAt-3600);
    verifyLeLocle($older===$seeded,'older seed cannot replace newer observation');
    $newerRequest=static fn():array=>['status'=>200,'body'=>$resultHtml];
    $resultNow+=900;
    $newerService=new DashboardLeLocleResults($seedDir,$newerRequest,$resultClock);
    $newerResults=$newerService->snapshot();
    verifyLeLocle(!$newerResults['resultsCheckFailed'] && $newerResults['resultsCheckedAt']!==$seeded['resultsCheckedAt'],'genuine successful source refresh clears seed warning');
    verifyLeLocle($newerService->seedFromVerifiedHtml(resultsPage(''),$captureAt)===$newerResults,'newer genuine source data preserved during repeated install');
    $invalidCapture=false; try{$seedService->seedFromVerifiedHtml($resultHtml,$resultNow+3600);}catch(RuntimeException){$invalidCapture=true;}
    verifyLeLocle($invalidCapture,'future capture rejected');
    foreach (['74009','68914'] as $teamId) {
        $team = DashboardAnfTeams::get($teamId);
        $teamHtml = str_replace(['Equipe - Juniors A','championnat Juniors A','FC Le Locle', 'v=919&amp;t=34107'],
            ['Equipe - '.$team['category'], 'championnat '.$team['category'], $team['name'], 'v='.$team['clubId'].'&amp;t='.$teamId],
            resultsPage(resultsRow('41','Di 08.11.2026','FC Le Locle','Fixture Futsal','0','3')));
        $alias = $teamId === '74009' ? 'FC Le Parc (SFPL)' : 'FC Le Parc 2 (1 L Futsal)';
        $teamHtml = str_replace(['<button id="ddmTeam">','</button>','<div id="fixture_tbResultate"', '>'.$team['name'].'<'],
            ['<h3>','</h3>','<div id="club_tbResultate" class="nisListeRD"></div><div id="fixture_tbResultate"', '>'.$alias.'<'], $teamHtml);
        $rows = DashboardLeLocleResults::parseResults($teamHtml, $resultNow, $teamId);
        verifyLeLocle(count($rows) === 1 && $rows[0]['home'] === $alias && $rows[0]['scoreHome'] === 0 && $rows[0]['url'] === $team['detailsUrl'], 'selected team completed result, observed heading, empty club calendar and fixed link');
        $ambiguous = str_replace('<div id="club_tbResultate" class="nisListeRD"></div>', '<div id="club_tbResultate" class="nisListeRD">'.resultsRow('42','Di 08.11.2026',$alias,'Fixture Futsal').'</div>', $teamHtml);
        $rejected = false; try { DashboardLeLocleResults::parseResults($ambiguous, $resultNow, $teamId); } catch (RuntimeException) { $rejected = true; }
        verifyLeLocle($rejected, 'two populated calendars cannot be combined');
        $wrongHeading = str_replace('<h3>Equipe - '.$team['category'].'</h3>', '<h3>Equipe - Wrong League</h3>', $teamHtml);
        $rejected = false; try { DashboardLeLocleResults::parseResults($wrongHeading, $resultNow, $teamId); } catch (RuntimeException) { $rejected = true; }
        verifyLeLocle($rejected, 'populated result calendar requires exact selected team heading');
        $crossed = false; try { DashboardLeLocleResults::parseResults($teamHtml, $resultNow, $teamId === '74009' ? '68914' : '74009'); } catch (RuntimeException) { $crossed = true; }
        verifyLeLocle($crossed, 'other futsal team cannot be accepted');
        $selectedDir = leLocleTestDirectory(); $selectedCalls = 0;
        $selectedRequest = static function (string $url) use (&$selectedCalls, $team): array { verifyLeLocle($url === $team['detailsUrl'], 'fixed selected result URL'); $selectedCalls++; return ['status'=>403,'body'=>'denied']; };
        $selectedResults = new DashboardLeLocleResults($selectedDir, $selectedRequest, $resultClock, $teamId);
        $selectedSeed = $selectedResults->seedFromVerifiedHtml($teamHtml, $resultNow - 300);
        verifyLeLocle(count($selectedSeed['results']) === 1 && $selectedSeed['resultsCheckedAt'] === gmdate('Y-m-d\TH:i:s\Z', (int)($resultNow-300)), 'selected browser seed retains capture time');
        verifyLeLocle($selectedResults->snapshot() === $selectedSeed && $selectedCalls === 1, 'selected source failure retains only its own results');
        $wrongTeamResults = new DashboardLeLocleResults($selectedDir, static fn (): array=>['status'=>403,'body'=>'denied'], $resultClock, $teamId === '74009' ? '68914' : '74009');
        verifyLeLocle($wrongTeamResults->snapshot()['resultsState'] === 'unavailable', 'other team state is not reused even in a shared accidental directory');
    }
    foreach (['FC Le Parc 2','FC Le Parc II','FC Le Parc (Jun.A)'] as $wrongOwner) verifyLeLocle(!DashboardAnfTeams::owner($wrongOwner, '74009'), 'first futsal team owner is exact');
    verifyLeLocle(DashboardAnfTeams::owner('FC Le Parc (SFPL)', '74009') && !DashboardAnfTeams::owner('FC Le Parc 2 (1 L Futsal)', '74009'), 'first official alias belongs only to its own team');
    verifyLeLocle(DashboardAnfTeams::owner('FC Le Parc 2 (1 L Futsal)', '68914') && !DashboardAnfTeams::owner('FC Le Parc (SFPL)', '68914'), 'second official alias belongs only to its own team');
    verifyLeLocle(DashboardAnfTeams::owner('FC Le Parc 2','68914') && !DashboardAnfTeams::owner('FC Le Parc','68914'), 'second futsal team owner is exact');
    $priorGet = $_GET; $priorServer = $_SERVER;
    try {
        $_GET = ['team'=>['74009']]; $_SERVER['REQUEST_METHOD'] = 'GET'; unset($_SERVER['HTTP_ORIGIN']);
        ob_start(); dashboardLeLocleRespond(); $invalidBody = ob_get_clean();
        verifyLeLocle(http_response_code() === 400 && $invalidBody === '{"error":"team_not_allowed"}', 'HTTP invalid team is rejected before source I/O');
    } finally { $_GET = $priorGet; $_SERVER = $priorServer; }
    echo "ANF_MULTITEAM_TESTS_PASSED\n";
    echo "LELOCLE_RESULTS_TESTS_PASSED\n";
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
