import os
import tempfile
import zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE = os.environ.get('I18N_URL', 'http://127.0.0.1:4411')
with sync_playwright() as p:
    browser = p.chromium.launch()
    for language in ('en-US', 'ru-RU'):
        page = browser.new_page(locale=language, viewport={'width': 1440, 'height': 1000})
        page.goto(BASE + '/?keep=yes#editor')
        page.wait_for_function('window.I18n && document.documentElement.lang === navigator.language.slice(0,2)')
        if 'static-studio' == 'decision-capsule':
            page.locator('[data-action="choose-template"][data-template="note"]').click()
        if 'decision-capsule' == 'decision-capsule':
            page.locator('[data-action="new"]').first.click()
        field = page.locator('#draft-question')
        field.fill('my unsaved text / мой текст')
        before = page.evaluate('location.hash')
        page.evaluate('window.__localeTestToken = "keep-me"')
        target = 'ru' if language == 'en-US' else 'en'
        page.locator('[data-locale="' + target + '"]').focus()
        page.locator('[data-locale="' + target + '"]').press('Enter')
        assert field.input_value() == 'my unsaved text / мой текст'
        assert page.evaluate('document.documentElement.lang') == target
        assert page.evaluate('location.hash') == before
        assert page.evaluate('window.__localeTestToken') == 'keep-me'
        assert 'keep=yes' in page.url
        assert page.locator('[data-locale="' + target + '"]').get_attribute('aria-pressed') == 'true'
        page.reload()
        assert page.evaluate('document.documentElement.lang') == target
        for width in (1440, 320, 390, 768, 1440):
            page.set_viewport_size({'width': width, 'height': 1000})
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        page.close()
    # Explicit links override a stored preference; invalid links fall through.
    context = browser.new_context(locale='ru-RU')
    context.add_init_script("localStorage.setItem('decision-capsule:locale', 'en')")
    page = context.new_page()
    page.goto(BASE + '/?lang=bad&keep=1')
    assert page.evaluate('I18n.locale') == 'en'
    page.goto(BASE + '/?lang=ru&keep=1')
    assert page.evaluate('I18n.locale') == 'ru'
    context.close()
    # The selector still works when persistence and URL history are blocked.
    context = browser.new_context(locale='en-US')
    context.add_init_script("Storage.prototype.getItem = () => { throw Error('blocked') }; Storage.prototype.setItem = () => { throw Error('blocked') }; history.replaceState = () => { throw Error('blocked') }")
    page = context.new_page()
    page.goto(BASE + '/?lang=en')
    if 'decision-capsule' == 'static-studio':
        page.locator('[data-action="choose-template"][data-template="note"]').click()
    page.locator('[data-locale="ru"]').click()
    assert page.evaluate('document.documentElement.lang') == 'ru'
    context.close()
    context = browser.new_context(locale='en-US', accept_downloads=True, viewport={'width':1440,'height':1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '/?lang=en')
    page.locator('[data-action="new"]').first.click()
    page.locator('[type="submit"]').click()
    assert page.locator('#form-error').inner_text() == 'write your question.'
    for key, value in [('question','my decision / мой вопрос'), ('context','my context / мой контекст')]:
        page.locator('[data-draft="' + key + '"]').fill(value)
        page.locator('[type="submit"]').click()
    page.locator('[data-option-index="0"]').fill('keep it')
    page.locator('[data-option-index="1"]').fill('change it')
    page.locator('[type="submit"]').click()
    page.locator('[data-draft="chosenPath"]').fill('keep this choice')
    page.locator('[type="submit"]').click()
    page.locator('[type="submit"]').click()
    page.locator('[data-draft="reviewDate"]').fill(page.evaluate("new Date().toLocaleDateString('sv-SE')"))
    page.locator('[type="submit"]').click()
    page.locator('[data-action="seal"]').click()
    page.locator('[data-action="open"]').click()
    page.locator('[data-action="confirm-open"]').click()
    assert not any('\u0400' <= char <= '\u04ff' for char in page.locator('.detail-aside').inner_text())
    page.locator('#result').fill('unsaved result / мой итог')
    page.locator('[data-locale="ru"]').click()
    assert page.locator('#result').input_value() == 'unsaved result / мой итог'
    page.locator('[data-locale="en"]').click()
    page.locator('#result-form [type="submit"]').click()
    with page.expect_download() as download:
        page.locator('[data-action="markdown"]').click()
    data = Path(download.value.path()).read_text()
    assert '# decision archive' in data and '### context' in data
    assert 'мой контекст' in data and 'мой итог' in data
    assert 'статус:' not in data
    assert errors == [], errors
    context.close()
    browser.close()
print('i18n browser: ok')
