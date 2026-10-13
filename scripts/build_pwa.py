"""Build the service worker and check that the site hangs together.

    python3 scripts/build_pwa.py           write site/sw.js
    python3 scripts/build_pwa.py --check   also fail if the committed sw.js was stale

What it does:

  1. Lists every file in site/ for the service worker to download on install.
  2. Hashes them all into a VERSION. Any change to any file changes the
     version, which changes sw.js, which is how browsers notice an update.
     This is the static-site version of versioned asset URLs: nothing needs a
     ?v= in its address, because the whole cache is replaced as one unit.
  3. Writes site/sw.js from scripts/sw.template.js.
  4. Checks links: every local href/src in the HTML, every import in the
     JavaScript, and every icon in the manifest must point at a real file.
     A broken one would make the install fail, so the build fails instead.

The deploy workflow runs this before publishing, so the live sw.js always
matches the live files.
"""

import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / 'site'
TEMPLATE = ROOT / 'scripts' / 'sw.template.js'
OUTPUT = SITE / 'sw.js'

SKIP = {'sw.js', '.nojekyll'}


def site_files():
    return sorted(
        p for p in SITE.rglob('*')
        if p.is_file() and p.name not in SKIP and not p.name.startswith('.')
    )


def version_of(files):
    h = hashlib.sha256()
    h.update(TEMPLATE.read_bytes())
    for p in files:
        h.update(p.relative_to(SITE).as_posix().encode())
        h.update(b'\0')
        h.update(p.read_bytes())
    return h.hexdigest()[:12]


def check_links(files):
    """Every local reference resolves to a file in site/."""
    problems = []
    attr = re.compile(r'''(?:href|src)=["']([^"'#]+)''')
    imports = re.compile(r'''(?:from|import)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]''')

    def resolve(base, ref):
        parsed = urlparse(ref)
        if parsed.scheme or ref.startswith('//') or ref.startswith('mailto:'):
            return None  # external
        target = (base.parent / parsed.path).resolve()
        if parsed.path.endswith('/') or target.is_dir():
            target = target / 'index.html'
        return target

    for p in files:
        if p.suffix == '.html':
            text = p.read_text(encoding='utf-8')
            # Skip template literals in inline scripts (they contain ${...}).
            for ref in attr.findall(text):
                if '${' in ref or ref.startswith('{'):
                    continue
                target = resolve(p, ref)
                if target and not target.exists():
                    problems.append(f'{p.relative_to(SITE)}: {ref} does not exist')
        elif p.suffix == '.js':
            for ref in imports.findall(p.read_text(encoding='utf-8')):
                target = resolve(p, ref)
                if target and not target.exists():
                    problems.append(f'{p.relative_to(SITE)}: import {ref} does not exist')

    manifest = json.loads((SITE / 'manifest.webmanifest').read_text(encoding='utf-8'))
    for icon in manifest['icons'] + [i for s in manifest.get('shortcuts', []) for i in s.get('icons', [])]:
        if not (SITE / icon['src']).exists():
            problems.append(f'manifest.webmanifest: icon {icon["src"]} does not exist')
    for s in manifest.get('shortcuts', []):
        path = urlparse(s['url']).path
        if path not in ('./', '') and not (SITE / path).exists():
            problems.append(f'manifest.webmanifest: shortcut {s["url"]} does not exist')
    return problems


def main():
    files = site_files()
    problems = check_links(files)
    if problems:
        print('Broken references:', *problems, sep='\n  ')
        sys.exit(1)

    version = version_of(files)
    precache = ['./'] + [p.relative_to(SITE).as_posix() for p in files]
    sw = (TEMPLATE.read_text(encoding='utf-8')
          .replace('__VERSION__', version)
          .replace('__PRECACHE__', json.dumps(precache, indent=2)))

    if '--check' in sys.argv and OUTPUT.exists() and OUTPUT.read_text(encoding='utf-8') != sw:
        print('site/sw.js is out of date: run python3 scripts/build_pwa.py and commit it.')
        sys.exit(1)

    OUTPUT.write_text(sw, encoding='utf-8')
    size = sum(p.stat().st_size for p in files)
    print(f'sw.js version {version}: {len(precache)} entries, {size / 1024:.0f} KB to download on install')


if __name__ == '__main__':
    main()
