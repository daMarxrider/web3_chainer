#!/usr/bin/env python3
"""Lines of the CLI that no test run executed, from raw V8 coverage of the CLI's child processes.

    CHAINER_COV_DIR=/tmp/cov node --test apps/cli/test/*.test.ts
    python3 scripts/cli-coverage.py /tmp/cov apps/cli/src/main.ts apps/cli/src/prompt.ts

A byte counts as run if any run executed it (V8 block coverage: the innermost range decides).
Blank lines, comments and lines with only brackets are not listed.
"""
import json, os, re, sys

cov_dir, files = sys.argv[1], sys.argv[2:]
for path in files:
    src = open(path, encoding='utf8').read()
    hit = [False] * len(src)
    url_end = os.path.abspath(path)
    for name in os.listdir(cov_dir):
        data = json.load(open(os.path.join(cov_dir, name)))
        for script in data.get('result', []):
            if not script['url'].endswith(url_end):
                continue
            # Collect ranges; innermost (shortest) range wins for each byte.
            ranges = sorted((r for fn in script['functions'] for r in fn['ranges']), key=lambda r: -(r['endOffset'] - r['startOffset']))
            count = [0] * len(src)
            for r in ranges:
                for i in range(r['startOffset'], min(r['endOffset'], len(src))):
                    count[i] = r['count']
            for i, c in enumerate(count):
                if c > 0:
                    hit[i] = True
    missed, offset = [], 0
    for n, line in enumerate(src.split('\n'), 1):
        code = line.strip()
        if code and not re.match(r'^(//|/\*|\*|[{}()\[\];,]+$)', code):
            if not any(hit[offset:offset + len(line)]):
                missed.append(n)
        offset += len(line) + 1
    print(f'{path}: {len(missed)} lines never run: {missed}')
