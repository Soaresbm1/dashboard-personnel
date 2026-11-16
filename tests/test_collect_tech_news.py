import importlib.util
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
import subprocess
import tempfile

SPEC = importlib.util.spec_from_file_location('tech_collector', Path(__file__).parents[1] / 'scripts' / 'collect-tech-news.py')
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)
NOW = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)
FEED = collector.FEEDS[0]


def rss_items(items):
    values = ''.join(f'<item><title><![CDATA[{title}]]></title><link>{url}</link><pubDate>{when}</pubDate><description>{description}</description></item>'
                     for title, url, when, description in items)
    return f'<rss version="2.0"><channel><title>Fixture</title>{values}</channel></rss>'.encode()


def article(title='Nvidia fixture announcement', path='fixture', when=None):
    return {'id': 'ignored', 'title': title, 'url': 'https://www.lemondeinformatique.fr/' + path,
            'source': FEED['name'], 'publishedAt': collector.iso(when or NOW - timedelta(hours=1))}


class CollectorTests(unittest.TestCase):
    def test_rss_only_recent_relevant_safe_public_headlines_without_full_content(self):
        data = rss_items([
            ('Nvidia &amp; IA fixture', 'https://www.lemondeinformatique.fr/fixture', 'Mon, 16 Nov 2026 11:00:00 GMT', 'Private <b>body discarded</b>'),
            ('OpenAI unsafe URL', 'https://evil.test/fixture', 'Mon, 16 Nov 2026 10:00:00 GMT', ''),
            ('Microsoft future', 'https://www.lemondeinformatique.fr/future', 'Tue, 17 Nov 2026 11:00:00 GMT', ''),
            ('Anthropic old', 'https://www.lemondeinformatique.fr/old', 'Sun, 01 Nov 2026 11:00:00 GMT', ''),
            ('Unrelated sport fixture', 'https://www.lemondeinformatique.fr/sport', 'Mon, 16 Nov 2026 10:00:00 GMT', ''),
        ])
        result = collector.rss(data, FEED, NOW)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['title'], 'Nvidia & IA fixture')
        self.assertEqual(set(result[0]), {'id', 'title', 'url', 'source', 'publishedAt'})

    def test_xml_doctype_entity_html_partial_and_oversize_rejected(self):
        for raw in (b'<html>blocked</html>', b'<rss><channel>', b'<!DOCTYPE rss><rss><channel/></rss>',
                    b'<!ENTITY example "fixture"><rss><channel/></rss>', b'x' * (collector.MAX_BYTES + 1)):
            with self.assertRaises((ValueError, collector.ET.ParseError)):
                collector.rss(raw, FEED, NOW)

    def test_article_deduplication_and_topic_diversity(self):
        rows = [article('OpenAI fixture ' + str(index), 'ai' + str(index), NOW - timedelta(minutes=index)) for index in range(5)]
        rows += [article('Nvidia fixture', 'gpu', NOW - timedelta(minutes=10)), article('Microsoft fixture', 'ms', NOW - timedelta(minutes=11)),
                 article('Anthropic fixture', 'claude', NOW - timedelta(minutes=12)), article('Nvidia fixture', 'duplicate', NOW - timedelta(minutes=13))]
        result = collector.clean_articles(rows, NOW)
        self.assertEqual(len(result), 5)
        self.assertTrue(any('Nvidia' in row['title'] for row in result))
        self.assertTrue(any('Microsoft' in row['title'] for row in result))
        self.assertTrue(any('Anthropic' in row['title'] for row in result))
        self.assertEqual(sum(row['title'] == 'Nvidia fixture' for row in result), 1)

    def test_active_incident_overrides_stale_all_operational_aggregate(self):
        summary = {'status': {'indicator': 'none'}, 'components': [{'status': 'operational'}]}
        incidents = {'incidents': [{'id': 'fixture-id', 'name': '<b>Example incident</b>', 'status': 'monitoring',
                                    'updated_at': collector.iso(NOW - timedelta(minutes=5))}]}
        result = collector.statuspage('openai', summary, incidents, NOW)
        self.assertEqual(result['status'], 'degraded')
        self.assertEqual(result['incident']['url'], 'https://status.openai.com/incidents/fixture-id')
        self.assertEqual(result['incident']['title'], 'Example incident')
        self.assertEqual(result['checkedAt'], collector.iso(NOW))

    def test_resolved_or_malformed_incidents_never_appear_as_active(self):
        summary = {'status': {'indicator': 'none'}, 'components': [{'status': 'operational'}]}
        result = collector.statuspage('anthropic', summary, {'incidents': [
            {'id': 'resolved', 'name': 'Resolved fixture', 'status': 'resolved', 'updated_at': collector.iso(NOW)}]}, NOW)
        self.assertEqual(result['status'], 'operational')
        self.assertIsNone(result['incident'])
        for incident in (
            {'id': '../unsafe', 'name': 'Unsafe fixture', 'status': 'investigating', 'updated_at': collector.iso(NOW)},
            {'id': 'future', 'name': 'Future fixture', 'status': 'identified', 'updated_at': collector.iso(NOW + timedelta(days=1))},
            {'id': 'unknown', 'name': 'Unknown state fixture', 'status': 'new-state', 'updated_at': collector.iso(NOW)},
        ):
            with self.assertRaises(ValueError):
                collector.statuspage('anthropic', summary, {'incidents': [incident]}, NOW)
        with self.assertRaises(ValueError):
            collector.statuspage('openai', summary, {}, NOW)

    def test_unknown_or_incomplete_vendor_summary_is_not_green(self):
        for summary in ({}, {'status': {'indicator': 'new-value'}, 'components': []}, {'status': {'indicator': 'none'}, 'components': []}):
            with self.assertRaises(ValueError):
                collector.statuspage('openai', summary, {'incidents': []}, NOW)

    def test_microsoft_scope_does_not_claim_all_m365_workloads_healthy(self):
        result = collector.microsoft_status({'Status': 'Available', 'LastUpdatedTime': collector.iso(NOW - timedelta(minutes=10)), 'Title': '', 'Message': '<b>not retained</b>'}, NOW)
        self.assertEqual(result['label'], 'Aucun avis public')
        self.assertIn('locataire', result['scope'])
        self.assertNotIn('Message', result)
        self.assertIn('portail admin', result['name'])
        with self.assertRaises(ValueError):
            collector.microsoft_status({'Status': 'Unavailable', 'LastUpdatedTime': collector.iso(NOW)}, NOW)

    def test_failures_preserve_original_service_and_news_observation_times(self):
        checked = collector.iso(NOW - timedelta(hours=2))
        previous = {'schemaVersion': 1, 'services': [dict(collector.base_service('openai'), status='degraded', checkedAt=checked,
                    incident={'title': 'Fixture issue', 'url': 'https://status.openai.com/incidents/fixture', 'updatedAt': checked})],
                    'articles': [article()], 'newsCheckedAt': checked}
        def failed(url):
            raise OSError('fixture source unavailable')
        result = collector.collect(previous, failed, NOW)
        openai = next(row for row in result['services'] if row['id'] == 'openai')
        self.assertEqual(openai['checkedAt'], checked)
        self.assertEqual(openai['status'], 'degraded')
        self.assertTrue(openai['checkFailed'])
        self.assertEqual(result['newsCheckedAt'], checked)
        self.assertTrue(result['newsCheckFailed'])
        self.assertEqual(len(result['articles']), 1)
        self.assertEqual(result['generatedAt'], collector.iso(NOW))

    def test_no_previous_data_and_failures_are_unknown_not_empty_success(self):
        result = collector.collect(None, lambda url: b'<html>blocked</html>', NOW)
        self.assertTrue(all(row['status'] == 'unknown' and row['checkedAt'] is None and row['checkFailed'] for row in result['services']))
        self.assertEqual(result['articles'], [])
        self.assertTrue(result['newsCheckFailed'])
        self.assertIsNone(result['newsCheckedAt'])

    def test_one_successful_empty_feed_is_a_real_empty_observation(self):
        def fetch(url):
            return b'<rss><channel/></rss>' if url == FEED['url'] else b'blocked'
        result = collector.collect({'schemaVersion': 1, 'articles': [article()]}, fetch, NOW)
        self.assertEqual(result['articles'], [])
        self.assertFalse(result['newsCheckFailed'])
        self.assertEqual(result['newsCheckedAt'], collector.iso(NOW))

    def test_fixed_fetch_target_and_unsafe_urls_rejected(self):
        with self.assertRaises(ValueError):
            collector.download('https://evil.test/anywhere')
        for url in ('http://www.lemondeinformatique.fr/a', 'https://user:password@www.lemondeinformatique.fr/a',
                    'https://www.lemondeinformatique.fr:444/a', 'javascript:alert(1)', 'https://evil.test/a'):
            self.assertIsNone(collector.safe_url(url, FEED['hosts']))

    def test_publisher_validates_without_a_token_or_external_writes(self):
        current = datetime.now(timezone.utc)
        snapshot = collector.collect(None, lambda url: b'blocked', current)
        publisher = Path(__file__).parents[1] / 'scripts' / 'publish-tech-news.mjs'
        workspace = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='dashboard-tech-fixture-', dir=workspace) as directory:
            self.assertTrue(Path(directory).resolve().is_relative_to(workspace))
            target = Path(directory) / 'tech-news.json'
            target.write_text(json.dumps(snapshot), encoding='utf-8')
            env = dict(os.environ, GITHUB_REPOSITORY='Soaresbm1/dashboard-personnel')
            env.pop('GITHUB_TOKEN', None)
            result = subprocess.run(['node', str(publisher.resolve()), '--validate-only'], cwd=directory, env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('without publication', result.stdout)
            snapshot['articles'] = [article(when=current)]
            snapshot['articles'][0]['id'] = '1' * 20
            snapshot['articles'][0]['url'] = 'https://evil.test/not-a-publisher'
            target.write_text(json.dumps(snapshot), encoding='utf-8')
            result = subprocess.run(['node', str(publisher.resolve()), '--validate-only'], cwd=directory, env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Invalid public headline', result.stderr)


if __name__ == '__main__':
    unittest.main()
