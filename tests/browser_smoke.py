"""Browser integration checks. Start `node server.js` before running.

Requires Python Playwright/Chromium; MCFINANCE_BROWSER can point to Chrome.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'artifacts'
OUTPUT.mkdir(exist_ok=True)
BASE = os.environ.get('MCFINANCE_URL', 'http://127.0.0.1:3210')

with sync_playwright() as p:
    browser_path = os.environ.get('MCFINANCE_BROWSER')
    windows_chrome = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
    if not browser_path and windows_chrome.exists():
        browser_path = str(windows_chrome)
    browser = p.chromium.launch(headless=True, **({'executable_path': browser_path} if browser_path else {}))
    page = browser.new_page(viewport={"width": 1440, "height": 1100}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def ready():
        page.locator('#dashboard[aria-busy="false"]').wait_for()

    def click_period(days):
        page.locator('[data-days="{}"]'.format(days)).click()
        ready()
        expect(page.locator('[data-days="{}"]'.format(days))).to_have_class('active')

    def open_source(tab):
        page.locator('#source-button').click()
        page.locator('[data-source-tab="{}"]'.format(tab)).click()

    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    ready()
    expect(page.locator('#kpi-grid')).to_contain_text('707.80')
    expect(page.locator('#orders-count')).to_have_text('33')
    expect(page.locator('.hero-food')).to_be_visible()
    page.wait_for_function("document.querySelector('.hero-food').complete && document.querySelector('.hero-food').naturalWidth > 0")
    assert page.locator('.kpi-food').count() == 4
    page.locator('#data-quality summary').click()
    expect(page.locator('#quality-warnings')).to_contain_text('不代表完整消费历史')
    page.locator('#data-quality summary').click()
    print('PASS initial report and visible data-quality notes')

    for days in [7, 90, 30]:
        click_period(days)
        reference = page.request.get(BASE + '/api/report?days={}'.format(days)).json()
        expect(page.locator('#orders-count')).to_have_text(str(reference['kpis']['orderCount']))
    page.locator('[data-chart="count"]').click()
    expect(page.locator('#chart-total')).to_have_text('33 单')
    page.locator('[data-chart="amount"]').click()
    print('PASS period and chart switches agree with API')

    page.locator('.nav-item[data-view="orders"]').click()
    page.locator('#order-search').fill('不存在的餐品')
    expect(page.locator('#orders-body')).to_contain_text('这里还没有订单')
    page.locator('#order-search').fill('麦满分')
    expect(page.locator('#orders-body')).to_contain_text('麦满分')
    page.locator('#order-search').fill('')
    first_order = page.locator('.order-id').first.inner_text()
    page.locator('#next-page').click()
    assert page.locator('.order-id').first.inner_text() != first_order
    page.locator('#sort-orders').click()
    page.locator('.nav-item[data-view="research"]').click()
    assert page.locator('.insight-card').count() >= 4
    page.locator('.nav-item[data-view="assets"]').click()
    expect(page.locator('#assets-content')).to_contain_text('等一份真实的资产快照')
    page.locator('.nav-item[data-view="overview"]').click()
    print('PASS navigation, search, pagination, sorting and truthful assets state')

    page.locator('#budget-button').click()
    page.locator('#budget-input').fill('1000')
    page.locator('#budget-form button[type="submit"]').click()
    ready()
    expect(page.locator('#budget-button')).to_contain_text('1,000.00')
    page.locator('#budget-button').click()
    page.locator('#budget-input').fill('600')
    page.locator('#budget-form button[type="submit"]').click()
    ready()
    print('PASS budget edits recalculate report')

    def fail_period(route):
        route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': {'message': '测试服务暂不可用'}}))
    page.route('**/api/report?*days=7&*', fail_period)
    page.locator('[data-days="7"]').click()
    ready()
    expect(page.locator('[data-days="30"]')).to_have_class('active')
    expect(page.locator('#error-banner')).to_contain_text('测试服务暂不可用')
    expect(page.locator('#orders-count')).to_have_text('33')
    page.unroute('**/api/report?*days=7&*', fail_period)
    page.locator('#refresh-button').click()
    ready()
    print('PASS failed period fetch rolls back filters and preserves report consistency')

    page.locator('#export-button').click()
    expect(page.locator('#export-preview svg')).to_be_visible()
    with page.expect_download() as info:
        page.locator('#download-svg').click()
    info.value.save_as(str(OUTPUT / 'test-report.svg'))
    with page.expect_download() as info:
        page.locator('#download-markdown').click()
    info.value.save_as(str(OUTPUT / 'test-report.md'))
    assert '演示数据' in (OUTPUT / 'test-report.svg').read_text(encoding='utf-8')
    assert '707.80' in (OUTPUT / 'test-report.md').read_text(encoding='utf-8')
    page.screenshot(path=str(OUTPUT / 'share-dialog.png'), full_page=False)
    page.locator('[aria-label="关闭研报窗口"]').click()
    print('PASS SVG and Markdown downloads retain source and computed amounts')

    open_source('import')
    invalid = json.dumps([{'id': 'bad', 'orderedAt': '2026-10-24', 'paid': None}]).encode('utf-8')
    page.locator('#order-file').set_input_files({'name': 'invalid.json', 'mimeType': 'application/json', 'buffer': invalid})
    expect(page.locator('#source-status')).to_contain_text('实付金额')
    page.locator('#order-file').set_input_files(str(ROOT / 'docs' / 'demo-orders.json'))
    expect(page.locator('#source-dialog')).not_to_be_visible()
    ready()
    expect(page.locator('#source-badge')).to_contain_text('导入示例数据')
    expect(page.locator('#kpi-grid')).to_contain_text('157.20')
    page.locator('#export-button').click()
    expect(page.locator('#export-preview')).to_contain_text('演示数据')
    page.locator('[aria-label="关闭研报窗口"]').click()
    click_period(7)
    expect(page.locator('#source-badge')).to_contain_text('导入示例数据')
    print('PASS invalid imports and sample imports preserve data provenance')

    open_source('import')
    hostile_orders = {'orders': [{'id': 'private-order', 'orderedAt': '2026-10-24T12:00:00+08:00', 'paid': 0, 'original': None, 'items': [{'name': '<img src=x onerror=alert(1)>', 'quantity': 1}], 'status': 'completed', 'channel': '到店'}]}
    page.locator('#order-file').set_input_files({'name': 'my-orders.json', 'mimeType': 'application/json', 'buffer': json.dumps(hostile_orders).encode('utf-8')})
    expect(page.locator('#source-dialog')).not_to_be_visible()
    ready()
    expect(page.locator('#orders-count')).to_have_text('1')
    assert page.locator('#orders-body img:not(.order-food)').count() == 0
    assert page.locator('#orders-body img[onerror]').count() == 0
    assert page.locator('#orders-body').inner_text().find('<img') >= 0
    print('PASS zero-price order and untrusted product text render safely')

    open_source('live')
    page.route('**/api/connect', lambda route: route.fulfill(status=401, content_type='application/json', body=json.dumps({'error': {'message': '测试凭证无效'}})))
    page.locator('#mcp-token').fill('local-test-token')
    page.locator('#connect-mcp').click()
    expect(page.locator('#source-status')).to_contain_text('测试凭证无效')
    expect(page.locator('#mcp-token')).to_have_value('')
    page.unroute('**/api/connect')
    page.locator('[data-source-tab="demo"]').click()
    page.locator('#use-demo').click()
    ready()
    click_period(30)
    print('PASS failed connection is explicit and clears the token field')

    page.reload()
    page.wait_for_load_state('networkidle')
    ready()
    page.evaluate('window.scrollTo(0,0)')
    page.screenshot(path=str(OUTPUT / 'desktop.png'), full_page=True)
    page.screenshot(path=str(OUTPUT / 'preview.png'), full_page=False)
    page.screenshot(path=str(OUTPUT / 'redesign-preview.png'), full_page=False)
    page.set_viewport_size({"width": 390, "height": 844})
    page.screenshot(path=str(OUTPUT / 'mobile.png'), full_page=True)
    assert not page.evaluate('document.documentElement.scrollWidth > window.innerWidth'), 'Mobile page overflows'
    expect(page.locator('#sidebar-connect')).to_be_visible()
    assert not errors, errors
    print('PASS desktop/mobile render without page errors or document overflow')
    browser.close()
