"""Verify an already-synchronized LOCAL live service, without reading credentials.

Personal exports are written exclusively to ignored private-data/.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('MCFINANCE_URL', 'http://127.0.0.1:3210')
OUTPUT = ROOT / 'private-data'
OUTPUT.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser_path = os.environ.get('MCFINANCE_BROWSER')
    windows_chrome = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
    if not browser_path and windows_chrome.exists():
        browser_path = str(windows_chrome)
    browser = p.chromium.launch(headless=True, **({'executable_path': browser_path} if browser_path else {}))
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    connection = page.request.get(BASE + '/api/connection').json()
    assert connection.get('connected') and connection.get('hasLiveData'), 'Connect and synchronize locally first'
    reference = page.request.get(BASE + '/api/report?source=live&days=30&budget=600').json()
    assert reference.get('source') == 'live'
    assets = page.request.get(BASE + '/api/assets?source=live').json()
    assert assets.get('source') == 'live'
    serialized_assets = json.dumps(assets)
    assert 'accountId' not in serialized_assets and 'Authorization' not in serialized_assets
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.locator('#dashboard[aria-busy="false"]').wait_for()
    expect(page.locator('#source-badge')).to_have_text('MCP 真实订单')
    expect(page.locator('#orders-count')).to_have_text(str(reference['kpis']['orderCount']))
    formatted = '{:,.2f}'.format(reference['kpis']['totalSpend'])
    expect(page.locator('#kpi-grid')).to_contain_text(formatted)
    if not reference['kpis']['savingsOrderCount'] and reference['kpis']['orderCount']:
        expect(page.locator('#kpi-grid')).to_contain_text('待补原价')
    print('PASS live dashboard loads real cached report with accurate amounts')

    for days in [7, 90, 30]:
        page.locator('[data-days="{}"]'.format(days)).click()
        page.locator('#dashboard[aria-busy="false"]').wait_for()
        expected = page.request.get(BASE + '/api/report?source=live&days={}'.format(days)).json()
        expect(page.locator('#orders-count')).to_have_text(str(expected['kpis']['orderCount']))
        expect(page.locator('#source-badge')).to_have_text('MCP 真实订单')
    print('PASS live period switches stay on real source')

    page.locator('.nav-item[data-view="assets"]').click()
    if isinstance(assets.get('account', {}).get('points'), (int, float)):
        expect(page.locator('#assets-content')).to_contain_text('{:,} 积分'.format(assets['account']['points']))
    expect(page.locator('#assets-content')).not_to_contain_text('等一份真实的资产快照')
    page.reload()
    page.wait_for_load_state('networkidle')
    page.locator('#dashboard[aria-busy="false"]').wait_for()
    expect(page.locator('#source-badge')).to_have_text('MCP 真实订单')
    print('PASS real assets mapping and reload retain server memory snapshot')

    page.locator('#export-button').click()
    expect(page.locator('#export-preview')).to_contain_text('MCP 实际返回订单')
    with page.expect_download() as info:
        page.locator('#download-svg').click()
    info.value.save_as(str(OUTPUT / 'McFinance-live.svg'))
    with page.expect_download() as info:
        page.locator('#download-markdown').click()
    info.value.save_as(str(OUTPUT / 'McFinance-live.md'))
    svg = (OUTPUT / 'McFinance-live.svg').read_text(encoding='utf-8')
    assert 'MCP 实际返回订单' in svg and '{:.2f}'.format(reference['kpis']['totalSpend']) in svg
    assert 'orderId' not in svg and 'accountId' not in svg
    assert not errors, errors
    print('PASS private SVG/Markdown exports preserve live source; no JavaScript errors')

    card = browser.new_page(viewport={'width': 800, 'height': 900})
    card.set_content('<html><head><style>html,body{margin:0;padding:0;background:#101913}</style></head><body>' + svg + '</body></html>')
    card.locator('svg').screenshot(path=str(OUTPUT / 'McFinance-live.png'))
    browser.close()
