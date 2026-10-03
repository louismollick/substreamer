#!/usr/bin/env python3
"""Check a pulled download-diagnostics folder against the acceptance criteria.

Usage: check-download-acceptance.py <folder written by pull-download-diagnostics.sh>

Reads download-diagnostics.jsonl (JS + native events), a copy of
substreamer7.db (+ WAL), the music-cache file listing, and optionally
navidrome.log. Prints one line per check and exits 1 if any check FAILs.
"""
import json
import pathlib
import sqlite3
import sys

# A registered song this small is an error document, not audio.
MIN_AUDIO_BYTES = 4096
TRANSCODE_LIMIT_MARKERS = ('too many concurrent transcodes', 'status=429', ' 429 ')

failures = 0


def report(status, name, detail=''):
    global failures
    if status == 'FAIL':
        failures += 1
    print(f'{status:4}  {name}' + (f' — {detail}' if detail else ''))


def read_events(root):
    path = root / 'download-diagnostics.jsonl'
    if not path.exists():
        return None
    events = []
    for line in path.read_text().splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return sorted(events, key=lambda e: e.get('ts', 0))


def check_events(events):
    if events is None:
        report('FAIL', 'diagnostics log', 'download-diagnostics.jsonl missing — diagnostics build?')
        return
    counts = {}
    for e in events:
        counts[e.get('event')] = counts.get(e.get('event'), 0) + 1
    report('INFO', 'event counts', json.dumps(counts, sort_keys=True))

    # Attribute every event to the app state of the latest heartbeat before it.
    app_state = 'active'
    done_background = 0
    items_background = 0
    last_heartbeat = None
    max_gap = 0.0
    for e in events:
        event = e.get('event')
        if event == 'heartbeat':
            if last_heartbeat is not None and e.get('appState') != 'active':
                max_gap = max(max_gap, (e['ts'] - last_heartbeat) / 1000)
            last_heartbeat = e['ts']
            app_state = e.get('appState', app_state)
        elif event in ('task.end', 'task.expired', 'queue.pause'):
            last_heartbeat = None
        elif event == 'song.done' and app_state != 'active':
            done_background += 1
        elif event == 'item.done' and app_state != 'active':
            items_background += 1

    report('PASS' if done_background > 0 else 'FAIL', 'songs finished in the background',
           f'{done_background} songs, {items_background} queue items')
    report('PASS' if max_gap < 30 else 'FAIL', 'JS kept running in the background',
           f'largest heartbeat gap {max_gap:.1f}s')

    rejected = [e for e in events if e.get('event') == 'song.rejected']
    limited = [e for e in rejected if e.get('status') in (429, 503)]
    not_audio = [e for e in rejected if e.get('reason') == 'notAudio']
    # The server's own limit (e.g. Navidrome's transcode cap) answers 429; the
    # queue lowers its concurrency and retries, so this is informational.
    report('INFO', 'server back-off responses', f'{len(limited)} 429/503, '
           f"{sum(1 for e in events if e.get('event') == 'cap.lowered')} cap reductions")
    dropped = sum(1 for e in events if e.get('event') == 'song.networkRetry')
    failed = sum(1 for e in events if e.get('event') == 'song.failed')
    report('INFO', 'network retries / songs failed', f'{dropped} / {failed}')
    report('INFO', 'non-audio bodies rejected before registration', str(len(not_audio)))

    expired = counts.get('task.expired', 0)
    report('INFO', 'background task', f"begun {counts.get('task.begin', 0)}, ended "
           f"{counts.get('task.end', 0)}, expired {expired}")

    cached = [e['cachedSongs'] for e in events if e.get('event') == 'heartbeat' and 'cachedSongs' in e]
    drops = sum(1 for a, b in zip(cached, cached[1:]) if b < a)
    if cached:
        report('PASS' if drops == 0 else 'FAIL', 'cached-song count never decreased',
               f'{cached[0]} → {cached[-1]} over {len(cached)} heartbeats, {drops} drops')


def check_database(root):
    """Returns the number of queue items still pending, or None without a copy."""
    db_path = root / 'substreamer7.db'
    if not db_path.exists():
        report('FAIL', 'database copy', 'substreamer7.db missing')
        return None
    db = sqlite3.connect(str(db_path))
    one = lambda sql: db.execute(sql).fetchone()[0]

    report('INFO', 'cached songs', str(one('SELECT COUNT(*) FROM cached_songs')))
    statuses = dict(db.execute('SELECT status, COUNT(*) FROM download_queue GROUP BY status').fetchall())
    report('INFO', 'queue items by status', json.dumps(statuses, sort_keys=True))
    errors = db.execute(
        "SELECT name, error FROM download_queue WHERE status = 'error' LIMIT 5").fetchall()
    for name, error in errors:
        report('INFO', 'queue error', f'{name}: {error}')
    report('PASS' if not statuses.get('error') else 'FAIL', 'no queue item ended in error',
           f"{statuses.get('error', 0)} items")

    tiny = db.execute(
        'SELECT song_id, bytes FROM cached_songs WHERE bytes < ?', (MIN_AUDIO_BYTES,)).fetchall()
    report('PASS' if not tiny else 'FAIL', 'no registered song is too small to be audio',
           ', '.join(f'{s}={b}B' for s, b in tiny[:10]))

    orphans = one('''SELECT COUNT(*) FROM cached_songs s
        WHERE NOT EXISTS (SELECT 1 FROM cached_item_songs e WHERE e.song_id = s.song_id)
          AND NOT EXISTS (SELECT 1 FROM download_queue_songs q WHERE q.song_id = s.song_id)''')
    report('PASS' if orphans == 0 else 'FAIL', 'every cached song is held', f'{orphans} unheld')

    duplicates = one('''SELECT COUNT(*) FROM (SELECT item_id FROM download_queue
        GROUP BY item_id HAVING COUNT(*) > 1)''')
    report('PASS' if duplicates == 0 else 'FAIL', 'no duplicate queue rows', f'{duplicates} items')

    stuck = one("SELECT COUNT(*) FROM download_queue WHERE status = 'downloading'")
    report('INFO', "items marked 'downloading' in the copy", str(stuck))
    return one("SELECT COUNT(*) FROM download_queue WHERE status IN ('queued', 'downloading')")


def file_names(node):
    """Yield every file name in a devicectl `info files` JSON listing."""
    if isinstance(node, dict):
        for key in ('name', 'relativePath', 'path'):
            value = node.get(key)
            if isinstance(value, str):
                yield value
        for value in node.values():
            yield from file_names(value)
    elif isinstance(node, list):
        for value in node:
            yield from file_names(value)


def check_files(root, pending):
    listing = root / 'music-cache.json'
    if not listing.exists():
        report('FAIL', 'music-cache listing', 'music-cache.json missing')
        return
    names = set(file_names(json.loads(listing.read_text())))
    tmp = sorted(n for n in names if n.endswith('.tmp'))
    # With downloads still pending a .tmp may be a live transfer.
    status = 'PASS' if not tmp else ('INFO' if pending else 'FAIL')
    report(status, 'no partial .tmp files left',
           ', '.join(tmp[:10]) + (f' (+{len(tmp) - 10})' if len(tmp) > 10 else ''))


def check_server(root):
    log = root / 'navidrome.log'
    if not log.exists():
        report('INFO', 'navidrome log', 'not supplied')
        return
    hits = [line for line in log.read_text(errors='replace').splitlines()
            if any(marker in line for marker in TRANSCODE_LIMIT_MARKERS)]
    report('PASS' if not hits else 'FAIL', 'no transcode-limit / 429 in Navidrome log',
           f'{len(hits)} lines' + (f', first: {hits[0][:160]}' if hits else ''))


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    root = pathlib.Path(sys.argv[1])
    check_events(read_events(root))
    pending = check_database(root)
    check_files(root, pending)
    check_server(root)
    print(f'\n{"FAILED" if failures else "PASSED"}: {failures} failing check(s)')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
