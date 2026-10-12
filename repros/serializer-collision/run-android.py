#!/usr/bin/env python3
"""Cold-start the serializer reproduction and preserve per-trial device logs."""
import argparse
import json
import re
import shlex
import subprocess
import time
from pathlib import Path

PACKAGE = 'dev.webgpu.serializercollision'
TAG = 'SERIALIZER_REPRO '
MISSING_CLASS = 'No native class registered for brand:'
EXIT_GRACE_SECONDS = 5
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--serial', required=True)
parser.add_argument('--repetitions', type=int, default=5)
parser.add_argument('--expect', choices=['baseline', 'fixed'], default='baseline')
parser.add_argument('--kinds', nargs='+', choices=['rect', 'paint', 'plain', 'buffer'])
parser.add_argument('--output', type=Path, default=Path(__file__).parent / 'results')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)


def adb(*parts, check=True):
    command = ['adb', '-s', args.serial, *parts]
    if parts and parts[0] == 'shell':
        command = ['adb', '-s', args.serial, 'shell', shlex.join(parts[1:])]
    return subprocess.run(command, text=True, capture_output=True, check=check)


def pid_lines(text, pid):
    # threadtime: "MM-DD HH:MM:SS.mmm  PID  TID L Tag: message"
    return [line for line in text.splitlines()
            if line.split(None, 3)[2:3] == [pid]]


def events(lines):
    rows = []
    for line in lines:
        if TAG not in line:
            continue
        try:
            rows.append(json.loads(line.split(TAG, 1)[1]))
        except json.JSONDecodeError:
            pass
    return rows


def run_pid(text, order, test, kind):
    for line in text.splitlines():
        if TAG not in line:
            continue
        try:
            row = json.loads(line.split(TAG, 1)[1])
        except json.JSONDecodeError:
            continue
        if row == {'event': 'start', 'order': order, 'test': test, 'kind': kind}:
            return line.split(None, 3)[2]
    return None


def fatal(lines, pid):
    text = '\n'.join(lines)
    if 'FATAL EXCEPTION' not in text or not re.search(rf'Process: {re.escape(PACKAGE)}, PID: {pid}\b', text):
        return None
    match = re.search(rf'{MISSING_CLASS} (\S+)', text)
    return match.group(1) if match else 'other'


def direct_outcome(data):
    box = [row for row in data if row.get('event') == 'direct-webgpu-box']
    wrong = [row for row in data if row.get('event') == 'direct-webgpu-unbox']
    right = [row for row in data if row.get('event') == 'direct-skia-unbox']
    if not (right and right[-1].get('success') is True and box):
        return 'direct-invalid'
    if box[-1].get('success') is False:
        return 'direct-rejected'
    classify = [row for row in data if row.get('event') == 'classify']
    if classify and classify[-1].get('webgpuAccepts') is False:
        return 'direct-not-claimed'
    if wrong and wrong[-1].get('success') is False and MISSING_CLASS in wrong[-1].get('error', ''):
        return 'direct-wrong-decoder'
    return 'direct-invalid'


baseline = {
    ('webgpu-first', 'direct', 'rect'): 'direct-wrong-decoder',
    ('skia-first', 'direct', 'rect'): 'direct-wrong-decoder',
    ('webgpu-first', 'transfer', 'rect'): 'crash',
    ('skia-first', 'transfer', 'rect'): 'success',
    ('webgpu-first', 'transfer', 'plain'): 'success',
    ('webgpu-first', 'transfer', 'buffer'): 'success',
    ('skia-first', 'transfer', 'buffer'): 'success',
    ('webgpu-first', 'transfer', 'paint'): 'crash',
    ('skia-first', 'transfer', 'paint'): 'success',
}
fixed = {case: 'direct-not-claimed' if case[1] == 'direct' else 'success' for case in baseline}
cases = [(*case, (fixed if args.expect == 'fixed' else baseline)[case]) for case in baseline
         if not args.kinds or case[2] in args.kinds]

results = []
for order, test, kind, expected in cases:
    for trial in range(1, args.repetitions + 1):
        key = f'{order}-{test}-{kind}-{trial}'
        log_path = args.output / (key + '.log')
        uri = f'serializer-repro://run?order={order}&test={test}&kind={kind}'
        adb('shell', 'am', 'force-stop', PACKAGE)
        actual, pid, crash_brand, exited_after = 'timeout', None, None, None
        with log_path.open('w') as stream:
            logger = subprocess.Popen([
                'adb', '-s', args.serial, 'logcat', '-v', 'threadtime', '-T', '1',
                'ReactNativeJS:I', 'AndroidRuntime:E', '*:S',
            ], stdout=stream, stderr=subprocess.STDOUT)
            try:
                launch = adb('shell', 'am', 'start', '-W', '-a',
                             'android.intent.action.VIEW', '-d', uri, PACKAGE,
                             check=False)
                (args.output / (key + '-launch.txt')).write_text(launch.stdout + launch.stderr)
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    time.sleep(.3)
                    text = log_path.read_text()
                    pid = pid or run_pid(text, order, test, kind)
                    if not pid:
                        continue
                    lines = pid_lines(text, pid)
                    data = events(lines)
                    if any(row.get('event') == 'setup-error' for row in data):
                        actual = 'setup-error'
                        break
                    crash_brand = fatal(lines, pid)
                    if crash_brand:
                        actual = 'crash' if crash_brand != 'other' else 'crash-other'
                        break
                    if any(row.get('event') == 'done' for row in data):
                        actual = direct_outcome(data) if test == 'direct' else 'success'
                        break
                if actual.startswith('crash'):
                    start = time.monotonic()
                    while time.monotonic() - start < EXIT_GRACE_SECONDS:
                        if adb('shell', 'pidof', PACKAGE, check=False).stdout.split() != [pid]:
                            exited_after = round(time.monotonic() - start, 2)
                            break
                        time.sleep(.2)
                elif actual not in ['timeout', 'setup-error']:
                    time.sleep(.5)
                    if pid not in adb('shell', 'pidof', PACKAGE, check=False).stdout.split():
                        actual = 'exited'
            finally:
                logger.terminate()
                logger.wait(timeout=5)
        lines = pid_lines(log_path.read_text(), pid) if pid else []
        result = {'order': order, 'test': test, 'kind': kind, 'trial': trial,
                  'expected': expected, 'actual': actual, 'matches': actual == expected,
                  'pid': pid, 'crashBrand': crash_brand,
                  'processExitedWithinGrace': exited_after is not None if actual.startswith('crash') else None,
                  'exitSeconds': exited_after,
                  'events': events(lines), 'log': str(log_path)}
        results.append(result)
        (args.output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps({k: v for k, v in result.items() if k not in ['events', 'log']}), flush=True)

summary = []
for order, test, kind, expected in cases:
    rows = [row for row in results if (row['order'], row['test'], row['kind']) == (order, test, kind)]
    outcomes = {}
    for row in rows:
        outcomes[row['actual']] = outcomes.get(row['actual'], 0) + 1
    summary.append({'order': order, 'test': test, 'kind': kind,
                    'expected': expected, 'trials': len(rows),
                    'matching': sum(row['matches'] for row in rows), 'outcomes': outcomes})
(args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
if not all(row['matches'] for row in results):
    raise SystemExit('At least one result differed from the expected behavior.')
