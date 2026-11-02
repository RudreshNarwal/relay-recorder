"""Check deployable website content without installing app dependencies."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
import json
import struct
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'public'
ORIGIN = 'https://relay.ideolyst.com'


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.ids = set()
        self.references = []
        self.meta = {}
        self.canonical = None
        self.h1 = 0
        self.lang = None
        self.images = []
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            assert attrs['id'] not in self.ids, f"Duplicate ID: {attrs['id']}"
            self.ids.add(attrs['id'])
        if tag == 'html':
            self.lang = attrs.get('lang')
        if tag == 'h1':
            self.h1 += 1
        if tag == 'meta':
            self.meta[attrs.get('name', attrs.get('property'))] = attrs.get('content')
        if tag == 'link' and attrs.get('rel') == 'canonical':
            self.canonical = attrs.get('href')
        if tag == 'img':
            assert 'alt' in attrs, 'Image is missing alt text'
            self.images.append(attrs)
        for name in ('href', 'src'):
            if name in attrs:
                self.references.append(attrs[name])
        assert not any(name.startswith('on') for name in attrs), 'Inline event handler violates CSP'
        assert 'style' not in attrs, 'Inline styles violate CSP'


pages = {path: Page(path.read_text()) for path in PUBLIC.glob('*.html')}
for path, page in pages.items():
    assert page.lang == 'en', f'{path.name}: missing language'
    assert page.h1 == 1, f'{path.name}: expected one main heading'
    assert page.meta.get('viewport'), f'{path.name}: missing viewport'
    for reference in page.references:
        url = urlsplit(reference)
        if url.scheme or url.netloc:
            assert url.scheme == 'https', f'Non-HTTPS external reference: {reference}'
            continue
        target = PUBLIC / unquote(url.path).lstrip('/') if url.path else path
        if target.is_dir():
            target /= 'index.html'
        assert target.resolve().is_relative_to(PUBLIC.resolve()), reference
        assert target.is_file(), f'Broken reference in {path.name}: {reference}'
        if url.fragment:
            target_page = pages.get(target) or Page(target.read_text())
            assert unquote(url.fragment) in target_page.ids, f'Unknown anchor: {reference}'

home = pages[PUBLIC / 'index.html']
assert home.canonical == ORIGIN + '/'
assert home.meta['og:url'] == home.canonical
assert len(home.meta['description']) > 40
assert home.meta['twitter:card'] == 'summary_large_image'
image_path = PUBLIC / urlsplit(home.meta['og:image']).path.lstrip('/')
width, height = struct.unpack('>II', image_path.read_bytes()[16:24])
assert (width, height) == (int(home.meta['og:image:width']), int(home.meta['og:image:height']))
assert home.meta['og:image'].startswith(ORIGIN + '/')
assert 'noindex' in pages[PUBLIC / '404.html'].meta['robots']
assert f'Sitemap: {ORIGIN}/sitemap.xml' in (PUBLIC / 'robots.txt').read_text()
locations = ET.parse(PUBLIC / 'sitemap.xml').findall('.//{http://www.sitemaps.org/schemas/sitemap/0.9}loc')
assert [item.text for item in locations] == [ORIGIN + '/']
config = json.loads((ROOT / 'wrangler.json').read_text())
assert (ROOT / config['assets']['directory']).resolve() == PUBLIC.resolve()
assert config['assets']['not_found_handling'] == '404-page'
assert config['routes'] == [{'pattern': 'relay.ideolyst.com', 'custom_domain': True}]
assert not any(p.name.startswith('.env') for p in PUBLIC.rglob('*'))
print(f'PASS: {len(pages)} pages, local links/anchors, image metadata, sitemap, and static deployment boundary.')
