#!/usr/bin/env python3
"""Collect bounded public vendor status and French technology headlines only."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import hashlib
import html
import json
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
import xml.etree.ElementTree as ET

UTC = timezone.utc
MAX_BYTES = 1_500_000
MAX_SNAPSHOT_BYTES = 50_000
PREVIOUS_URL = 'https://raw.githubusercontent.com/Soaresbm1/dashboard-personnel/tech-news-data/tech-news.json'
SERVICES = {
    'microsoft': {'name': 'Microsoft · portail admin', 'url': 'https://status.cloud.microsoft/',
                  'summary': 'https://status.cloud.microsoft/api/posts/mac',
                  'scope': 'Accès au centre d’administration Microsoft 365 uniquement ; les incidents du locataire ne sont pas inclus.'},
    'openai': {'name': 'OpenAI', 'url': 'https://status.openai.com/',
               'summary': 'https://status.openai.com/api/v2/summary.json',
               'incidents': 'https://status.openai.com/api/v2/incidents.json'},
    'anthropic': {'name': 'Anthropic', 'url': 'https://status.claude.com/',
                  'summary': 'https://status.claude.com/api/v2/summary.json',
                  'incidents': 'https://status.claude.com/api/v2/incidents.json'},
}
FEEDS = (
    {'name': 'Le Monde Informatique', 'url': 'https://www.lemondeinformatique.fr/rss.xml',
     'hosts': {'www.lemondeinformatique.fr', 'lemondeinformatique.fr'}},
    {'name': 'Numerama', 'url': 'https://www.numerama.com/feed/',
     'hosts': {'www.numerama.com', 'numerama.com'}},
    {'name': 'Le Monde · Pixels', 'url': 'https://www.lemonde.fr/pixels/rss_full.xml',
     'hosts': {'www.lemonde.fr', 'lemonde.fr'}},
)
LABELS = {'operational': 'Opérationnel', 'degraded': 'Perturbation', 'outage': 'Panne',
          'maintenance': 'Maintenance', 'unknown': 'À vérifier'}
RELEVANT = re.compile(r'\b(?:microsoft|openai|anthropic|claude|chatgpt|nvidia|jensen|ia|cloud|cyber(?:sécurité|securite|security|attaque\w*|crime\w*|menace\w*|incident\w*)|ransomware|panne\w*)\b|intelligence artificielle', re.I)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def parse_time(value: object) -> datetime:
    if not isinstance(value, str) or len(value) > 100:
        raise ValueError('invalid date')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        result = parsedate_to_datetime(value)
    if result.tzinfo is None:
        raise ValueError('missing date timezone')
    return result.astimezone(UTC)


def text(value: object, limit: int = 300) -> str:
    if not isinstance(value, str):
        return ''
    value = re.sub(r'<[^>]*>', ' ', html.unescape(value)).replace('<', '').replace('>', '')
    return re.sub(r'\s+', ' ', value).strip()[:limit]


def safe_url(value: object, hosts: set[str]) -> str | None:
    if not isinstance(value, str) or len(value) > 1500 or any(ord(c) < 32 for c in value):
        return None
    try:
        parsed = urlparse(value)
        if parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        return parsed._replace(fragment='').geturl()
    except ValueError:
        return None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def download(url: str) -> bytes:
    """No credentials, arbitrary targets, or cross-origin redirect following."""
    fixed = {PREVIOUS_URL}
    for service in SERVICES.values():
        fixed.update(service[key] for key in ('summary', 'incidents') if key in service)
    fixed.update(feed['url'] for feed in FEEDS)
    if url not in fixed:
        raise ValueError('unconfigured source')
    opener = build_opener(NoRedirect())
    req = Request(url, headers={'User-Agent': 'DashboardPublicTech/1.0 (+https://soaresbm1.github.io/dashboard-personnel/)',
                                'Accept': 'application/json, application/rss+xml, application/xml, text/xml;q=0.9'})
    with opener.open(req, timeout=15) as response:
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError('oversized source')
        return data


def json_object(raw: bytes) -> dict:
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('invalid JSON source')
    return value


def base_service(service_id: str) -> dict:
    config = SERVICES[service_id]
    value = {'id': service_id, 'name': config['name'], 'url': config['url'],
             'status': 'unknown', 'label': LABELS['unknown'], 'checkedAt': None,
             'incident': None, 'checkFailed': True}
    if config.get('scope'):
        value['scope'] = config['scope']
    return value


def statuspage(service_id: str, summary: dict, incidents_data: dict, now: datetime) -> dict:
    config = SERVICES[service_id]
    indicator = summary.get('status', {}).get('indicator')
    statuses = {'none': 'operational', 'minor': 'degraded', 'major': 'outage',
                'critical': 'outage', 'maintenance': 'maintenance'}
    if indicator not in statuses or not isinstance(summary.get('components'), list) or not summary['components']:
        raise ValueError('incomplete status summary')
    incidents = incidents_data.get('incidents')
    if not isinstance(incidents, list) or len(incidents) > 100:
        raise ValueError('incomplete incident response')
    active = []
    for incident in incidents:
        if not isinstance(incident, dict):
            raise ValueError('invalid incident')
        if incident.get('status') in {'resolved', 'postmortem', 'completed'}:
            continue
        if incident.get('status') not in {'investigating', 'identified', 'monitoring'}:
            raise ValueError('unknown incident state')
        title, incident_id = text(incident.get('name'), 220), incident.get('id')
        try:
            at = parse_time(incident.get('updated_at'))
        except (ValueError, TypeError, OverflowError):
            raise ValueError('invalid active incident date') from None
        if not title or not isinstance(incident_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', incident_id) or at > now + timedelta(minutes=5):
            raise ValueError('invalid active incident')
        active.append({'title': title, 'url': config['url'] + 'incidents/' + incident_id, 'updatedAt': iso(at)})
    active.sort(key=lambda row: row['updatedAt'], reverse=True)
    status = statuses[indicator]
    if active and status == 'operational':
        status = 'degraded'
    value = base_service(service_id)
    value.update(status=status, label=LABELS[status], checkedAt=iso(now),
                 incident=active[0] if active else None, checkFailed=False)
    return value


def previous_service(service_id: str, previous: dict, now: datetime) -> dict:
    result = base_service(service_id)
    rows = previous.get('services', [])
    if not isinstance(rows, list):
        return result
    for row in rows[:3]:
        if not isinstance(row, dict) or row.get('id') != service_id or row.get('status') not in LABELS or row.get('url') != result['url']:
            continue
        try:
            at = parse_time(row.get('checkedAt'))
        except (ValueError, TypeError, OverflowError):
            continue
        if at > now + timedelta(minutes=5) or now - at > timedelta(days=7):
            continue
        result.update(status=row['status'], label=LABELS[row['status']], checkedAt=iso(at), checkFailed=True)
        incident = row.get('incident')
        if isinstance(incident, dict):
            url = safe_url(incident.get('url'), {urlparse(result['url']).hostname})
            try:
                updated = parse_time(incident.get('updatedAt'))
                if url and text(incident.get('title')) and updated <= now + timedelta(minutes=5):
                    result['incident'] = {'title': text(incident['title'], 220), 'url': url, 'updatedAt': iso(updated)}
            except (ValueError, TypeError, OverflowError):
                pass
        return result
    return result


def microsoft_status(data: dict, now: datetime) -> dict:
    states = {'Available': ('operational', 'Aucun avis public'),
              'Operational': ('operational', 'Aucun avis public'),
              'Service restored': ('operational', 'Avis de rétablissement'),
              'Service degradation': ('degraded', 'Portail perturbé'),
              'Unknown': ('unknown', 'À vérifier')}
    if data.get('Status') not in states:
        raise ValueError('unknown Microsoft public status')
    # This public endpoint covers access to the admin center, not all M365 services.
    # Its body explains the scope; do not save its HTML or infer tenant health.
    updated = parse_time(data.get('LastUpdatedTime'))
    if updated > now + timedelta(minutes=5):
        raise ValueError('future Microsoft update')
    status, label = states[data['Status']]
    result = base_service('microsoft')
    title = text(data.get('Title'), 220)
    incident = {'title': title, 'url': result['url'], 'updatedAt': iso(updated)} if title and status == 'degraded' else None
    result.update(status=status, label=label, checkedAt=iso(now), incident=incident, checkFailed=False)
    return result


def rss(raw: bytes, feed: dict, now: datetime) -> list[dict]:
    if len(raw) > MAX_BYTES or re.search(br'<!\s*(?:DOCTYPE|ENTITY)\b', raw, re.I):
        raise ValueError('unsafe or oversized XML')
    root = ET.fromstring(raw)
    if root.tag != 'rss' or root.find('channel') is None:
        raise ValueError('unexpected RSS source')
    items = root.findall('./channel/item')
    if len(items) > 250:
        raise ValueError('oversized item list')
    rows = []
    for item in items:
        title = text(item.findtext('title'), 240)
        url = safe_url(text(item.findtext('link'), 1500), feed['hosts'])
        description = text(item.findtext('description'), 600)
        try:
            at = parse_time(item.findtext('pubDate'))
        except (ValueError, TypeError, OverflowError):
            continue
        if not title or not url or not RELEVANT.search(title + ' ' + description) or at > now + timedelta(minutes=5) or now - at > timedelta(days=7):
            continue
        rows.append({'id': hashlib.sha256(url.encode()).hexdigest()[:20], 'title': title, 'url': url,
                     'source': feed['name'], 'publishedAt': iso(at)})
    return rows


def clean_articles(rows: object, now: datetime) -> list[dict]:
    if not isinstance(rows, list):
        return []
    result, seen = [], set()
    by_name = {feed['name']: feed for feed in FEEDS}
    for row in sorted((row for row in rows[:1000] if isinstance(row, dict)), key=lambda row: str(row.get('publishedAt', '')), reverse=True):
        feed = by_name.get(row.get('source'))
        if not feed:
            continue
        title, url = text(row.get('title'), 240), safe_url(row.get('url'), feed['hosts'])
        try:
            at = parse_time(row.get('publishedAt'))
        except (ValueError, TypeError, OverflowError):
            continue
        dedupe = re.sub(r'\W+', '', title.casefold())
        if not title or not url or url in seen or dedupe in seen or at > now + timedelta(minutes=5) or now - at > timedelta(days=7):
            continue
        seen.update((url, dedupe))
        result.append({'id': hashlib.sha256(url.encode()).hexdigest()[:20], 'title': title, 'url': url,
                       'source': feed['name'], 'publishedAt': iso(at)})
    # Prefer a spread of the requested subjects to five near-identical AI stories.
    selected, topics = [], set()
    topic_patterns = (('nvidia', r'\b(?:nvidia|jensen)\b'), ('microsoft', r'\bmicrosoft\b'),
                      ('openai', r'\b(?:openai|chatgpt)\b'), ('anthropic', r'\b(?:anthropic|claude)\b'),
                      ('security', r'\b(?:cyber(?:sécurité|securite|security|attaque\w*|crime\w*|menace\w*|incident\w*)|ransomware)\b'))
    for row in result:
        topic = next((name for name, pattern in topic_patterns if re.search(pattern, row['title'], re.I)), None)
        if topic and topic not in topics:
            selected.append(row)
            topics.add(topic)
        if len(selected) == 5:
            break
    selected_ids = {row['id'] for row in selected}
    selected.extend(row for row in result if row['id'] not in selected_ids)
    return sorted(selected[:5], key=lambda row: row['publishedAt'], reverse=True)


def collect(previous: dict | None = None, fetch=download, now: datetime | None = None) -> dict:
    now = now or datetime.now(UTC)
    previous = previous if isinstance(previous, dict) and previous.get('schemaVersion') == 1 else {}
    targets = [feed['url'] for feed in FEEDS]
    for config in SERVICES.values():
        targets.extend(config[key] for key in ('summary', 'incidents') if key in config)
    def safe_fetch(url):
        try:
            return fetch(url)
        except Exception:
            return None
    with ThreadPoolExecutor(max_workers=7) as pool:
        responses = dict(zip(targets, pool.map(safe_fetch, targets)))
    services = []
    for service_id, config in SERVICES.items():
        try:
            if service_id == 'microsoft':
                value = microsoft_status(json_object(responses[config['summary']]), now)
            else:
                value = statuspage(service_id, json_object(responses[config['summary']]), json_object(responses[config['incidents']]), now)
        except Exception:
            value = previous_service(service_id, previous, now)
        services.append(value)
    articles, successes = [], 0
    for feed in FEEDS:
        try:
            articles.extend(rss(responses[feed['url']], feed, now))
            successes += 1
        except Exception:
            pass
    checked_at = iso(now) if successes else None
    if not successes:
        articles = previous.get('articles', [])
        try:
            at = parse_time(previous.get('newsCheckedAt'))
            if at <= now + timedelta(minutes=5):
                checked_at = iso(at)
        except (ValueError, TypeError, OverflowError):
            pass
    result = {'schemaVersion': 1, 'generatedAt': iso(now), 'services': services,
              'articles': clean_articles(articles, now), 'newsCheckedAt': checked_at, 'newsCheckFailed': successes == 0}
    if len(json.dumps(result, ensure_ascii=False).encode()) > MAX_SNAPSHOT_BYTES:
        raise ValueError('oversized snapshot')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='tech-news.json')
    parser.add_argument('--previous', help='Optional previously downloaded local public snapshot')
    args = parser.parse_args()
    previous = None
    try:
        previous = json_object(Path(args.previous).read_bytes() if args.previous else download(PREVIOUS_URL))
    except Exception:
        pass
    result = collect(previous)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f"Collected public tech snapshot: {sum(not value['checkFailed'] for value in result['services'])}/3 services, {len(result['articles'])} headlines.")


if __name__ == '__main__':
    main()
