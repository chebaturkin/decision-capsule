from pathlib import Path
import argparse
import json
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser(description='Check decision capsule in an isolated Chromium browser.')
parser.add_argument('--url', default='http://127.0.0.1:5173')
parser.add_argument('--screenshots', action='store_true', help='Refresh illustrative screenshots in docs/screenshots.')
args = parser.parse_args()
base = args.url.rstrip('/')
shots = Path(__file__).resolve().parents[1] / 'docs' / 'screenshots'
if args.screenshots:
    shots.mkdir(parents=True, exist_ok=True)
errors = []

seed = '''async () => {
  const {createCapsule, openCapsule, saveResult, localDate} = await import('./lib/model.js?v=3');
  const {openRepository} = await import('./lib/repository.js?v=3');
  const repo = await openRepository();
  const now = new Date();
  const date = (days) => { const d = new Date(now); d.setDate(d.getDate() + days); return d; };
  const common = {confidence: 65, options: ['оставить как есть', 'попробовать другой подход']};
  const ready = createCapsule({...common, id: 'example-ready', number: 1,
    question: 'оставить ли пятницу без встреч?',
    context: 'встречи разбивают день на короткие отрезки. хочу проверить, получится ли больше сделать, если собрать их в другие дни.',
    chosenPath: 'на две недели перенести пятничные встречи на вторник и четверг.',
    reviewDate: localDate(now)}, date(-14));
  const sealed = createCapsule({...common, id: 'example-sealed', number: 2,
    question: 'стоит ли запускать небольшой курс?',
    context: 'есть программа и несколько человек, которым интересна тема. сначала нужно понять, сколько времени займёт подготовка.',
    chosenPath: 'провести одну встречу и собрать обратную связь перед запуском курса.',
    reviewDate: localDate(date(14))}, date(-2));
  let opened = createCapsule({...common, id: 'example-opened', number: 3,
    question: 'вести заметки в одном месте?',
    context: 'заметки разбросаны по нескольким приложениям, и нужную мысль приходится искать заново.',
    chosenPath: 'месяц вести все рабочие заметки в одном приложении.',
    reviewDate: localDate(date(-7))}, date(-37));
  opened = openCapsule(opened, date(-7));
  opened = saveResult(opened, 'стало проще находить старые записи. оставляю один архив, а короткие заметки разбираю в конце недели.', date(-6));
  await repo.importCapsules([ready, sealed, opened]);
}'''

def check_layout(page, label):
    assert not page.evaluate('document.documentElement.scrollWidth > window.innerWidth'), f'overflow: {label}'

def shot(page, name):
    if not args.screenshots:
        return
    if page.locator('#draft-status').count():
        expect(page.locator('#draft-status')).to_have_text('сохранено в браузере')
    page.evaluate('document.activeElement?.blur()')
    page.screenshot(path=str(shots / name), full_page=name != 'share.png')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width":1440,"height":1050}, timezone_id='Europe/Moscow', accept_downloads=True)
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base)
    page.wait_for_load_state('networkidle')
    expect(page.locator('h1')).to_have_text('решения')
    assert page.locator('[data-action="filter"]').count() == 0
    assert page.locator('.eyebrow, .sidebar, .archive-kicker, .summary-strip').count() == 0
    page.locator('.skip-link').focus()
    page.keyboard.press('Enter')
    expect(page).to_have_url(base + '/#main-content')
    expect(page.get_by_role('dialog')).to_have_count(0)
    shot(page, 'empty.png')
    # Create a real capsule through all six steps, validate, resume and seal.
    page.locator('[data-action="new"]').first.click()
    page.locator('[type="submit"]').click()
    expect(page.locator('#form-error')).to_have_text('сформулируйте вопрос.')
    page.locator('[data-draft="question"]').fill('выделить ли утро для работы без сообщений?')
    page.locator('[type="submit"]').click()
    page.locator('[data-draft="context"]').fill('нужно закончить большой текст. сообщения отвлекают, а к вечеру уже сложно сосредоточиться.')
    page.locator('[type="submit"]').click()
    page.locator('[data-option-index="0"]').fill('отвечать сразу')
    page.locator('[data-option-index="1"]').fill('читать сообщения после обеда')
    page.locator('[data-action="add-option"]').click()
    page.locator('[data-option-index="2"]').fill('проверять сообщения раз в час')
    page.locator('[data-action="remove-option"]').last.click()
    expect(page.locator('h1')).to_have_text('какие варианты есть?')
    assert page.locator('[data-option-index]').count() == 2
    page.locator('[type="submit"]').click()
    page.locator('[data-draft="chosenPath"]').fill('две недели читать сообщения после обеда и посмотреть, как меняется работа.')
    shot(page, 'create.png')
    page.locator('[data-action="archive"]').last.click()
    expect(page.locator('.draft-banner')).to_be_visible()
    page.reload()
    expect(page.locator('.draft-banner')).to_be_visible()
    page.locator('[data-action="resume-draft"]').click()
    expect(page.locator('[data-draft="chosenPath"]')).to_have_value('две недели читать сообщения после обеда и посмотреть, как меняется работа.')
    page.locator('[type="submit"]').click()
    page.locator('[data-draft="confidence"]').fill('70')
    expect(page.locator('#confidence-value')).to_have_text('70%')
    page.locator('[type="submit"]').click()
    page.locator('[data-action="date-preset"][data-days="7"]').click()
    today = page.evaluate("new Date().toLocaleDateString('sv-SE')")
    page.locator('[data-draft="reviewDate"]').fill(today)
    page.locator('[type="submit"]').click()
    expect(page.locator('h1')).to_have_text('всё верно?')
    shot(page, 'review.png')
    page.locator('[data-action="seal"]').click()
    expect(page.locator('[data-action="open"]')).to_be_visible()
    page.locator('[data-action="open"]').click()
    expect(page.get_by_role('dialog')).to_be_visible()
    # Escape closes and restores focus.
    page.keyboard.press('Escape')
    expect(page.locator('[data-action="open"]')).to_be_focused()
    page.locator('[data-action="open"]').click()
    page.locator('[data-action="confirm-open"]').click()
    expect(page.locator('#result-form')).to_be_visible()
    page.locator('#result-form [type="submit"]').click()
    expect(page.locator('#result-error')).to_have_text('добавьте итог или наблюдение.')
    page.locator('#result').fill('утром удалось закончить текст. срочные вопросы не пострадали, оставляю этот порядок.')
    page.locator('#result-form [type="submit"]').click()
    expect(page.locator('.toast')).to_contain_text('итог сохранён.')
    page.reload()
    page.locator('[data-action="detail"]').click()
    expect(page.locator('#result')).to_have_value('утром удалось закончить текст. срочные вопросы не пострадали, оставляю этот порядок.')
    page.locator('[data-action="share"]').click()
    expect(page.get_by_role('dialog')).to_contain_text('данные в ссылке не зашифрованы')
    share_url = page.locator('.url-copy').input_value()
    # Tab and shift-tab stay inside the dialog.
    page.locator('.dialog button').last.focus()
    page.keyboard.press('Tab')
    expect(page.locator('.url-copy')).to_be_focused()
    page.keyboard.press('Shift+Tab')
    expect(page.locator('.dialog button').last).to_be_focused()
    page.keyboard.press('Escape')
    with page.expect_download() as download_info:
        page.locator('[data-action="markdown"]').click()
    assert '# архив решений' in Path(download_info.value.path()).read_text()
    page.locator('[data-action="archive"]').first.click()
    with page.expect_download() as download_info:
        page.locator('[data-action="export"]').click()
    archive_path = str(download_info.value.path())
    assert len(json.loads(Path(archive_path).read_text())['capsules']) == 1
    page.locator('[data-action="import"]').click()
    page.locator('#import-file').set_input_files(archive_path)
    expect(page.locator('.import-summary')).to_contain_text('уже в архиве')
    expect(page.locator('[data-action="confirm-import"]')).to_be_disabled()
    page.keyboard.press('Escape')
    # Import by link and by file in an empty isolated browser.
    transfer_context = browser.new_context(timezone_id='Europe/Moscow')
    transfer = transfer_context.new_page()
    transfer.on('pageerror', lambda e: errors.append(str(e)))
    transfer.goto(share_url)
    expect(transfer.get_by_role('dialog')).to_be_visible()
    transfer.locator('[data-action="import-hash"]').click()
    expect(transfer.locator('.capsule-card')).to_have_count(1)
    transfer_context.close()
    file_context = browser.new_context(timezone_id='Europe/Moscow')
    transfer = file_context.new_page()
    transfer.on('pageerror', lambda e: errors.append(str(e)))
    transfer.goto(base)
    transfer.locator('[data-action="import"]').click()
    transfer.locator('#import-file').set_input_files(archive_path)
    expect(transfer.locator('[data-action="confirm-import"]')).to_be_enabled()
    transfer.locator('[data-action="confirm-import"]').click()
    expect(transfer.locator('.capsule-card')).to_have_count(1)
    file_context.close()
    context.close()
    # Screenshots use only illustrative records in a fresh context.
    context = browser.new_context(viewport={"width":1440,"height":1050}, timezone_id='Europe/Moscow')
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base)
    page.wait_for_load_state('networkidle')
    page.evaluate(seed)
    page.reload()
    expect(page.locator('.capsule-card')).to_have_count(3)
    assert page.locator('[data-action="filter"]').count() == 4
    shot(page, 'archive.png')
    page.locator('[data-action="filter"][data-filter="ready"]').click()
    expect(page.locator('.capsule-card')).to_have_count(1)
    page.locator('[data-action="filter"][data-filter="sealed"]').click()
    expect(page.locator('.capsule-card')).to_have_count(1)
    page.locator('[data-action="detail"]').click()
    expect(page.locator('[data-action="open"]')).to_have_count(0)
    expect(page.locator('.notice')).to_contain_text('открыть можно')
    page.locator('[data-action="archive"]').first.click()
    page.locator('[data-action="filter"][data-filter="all"]').click()
    page.locator('#search').press_sequentially('заметки', delay=40)
    expect(page.locator('#search')).to_be_focused()
    expect(page.locator('.capsule-card')).to_have_count(1)
    assert page.locator('#search').input_value() == 'заметки'
    page.locator('#search').fill('несуществующее решение')
    expect(page.locator('.empty')).to_contain_text('ничего не найдено')
    page.locator('[data-action="clear-search"]').first.click()
    expect(page.locator('.capsule-card')).to_have_count(3)
    page.locator('#sort').select_option('created-desc')
    page.locator('[data-action="detail"][data-id="example-opened"]').click()
    original_result = page.locator('#result').input_value()
    with page.expect_download():
        page.locator('[data-action="markdown"]').click()
    page.locator('#result').fill('несохранённый итог, который должен остаться после уведомления')
    expect(page.locator('.toast')).to_be_hidden(timeout=6000)
    expect(page.locator('#result')).to_have_value('несохранённый итог, который должен остаться после уведомления')
    page.locator('[data-action="share"]').click()
    page.keyboard.press('Escape')
    expect(page.locator('#result')).to_have_value('несохранённый итог, который должен остаться после уведомления')
    page.evaluate('''() => new Promise(resolve => {
      const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
      observer.observe(document.querySelector('#app'), {childList: true});
      document.dispatchEvent(new Event('visibilitychange'));
    })''')
    expect(page.locator('#result')).to_have_value('несохранённый итог, который должен остаться после уведомления')
    page.locator('#result').fill(original_result)
    shot(page, 'detail.png')
    page.locator('[data-action="share"]').click()
    shot(page, 'share.png')
    page.keyboard.press('Escape')
    for width in [320, 390, 768, 1440]:
        page.set_viewport_size({"width":width,"height":844})
        check_layout(page, f'detail {width}')
        page.locator('[data-action="archive"]').first.click()
        check_layout(page, f'archive {width}')
        page.locator('[data-action="new"]').first.click()
        check_layout(page, f'form {width}')
        if width == 390:
            shot(page, 'mobile-create.png')
        page.locator('[data-action="archive"]').last.click()
        expect(page.locator('h1')).to_have_text('решения')
        if width == 390:
            shot(page, 'mobile.png')
        page.locator('[data-action="detail"][data-id="example-opened"]').click()
    page.locator('[data-action="archive"]').first.click()
    page.locator('[data-action="filter"][data-filter="all"]').click()
    page.locator('[data-action="detail"][data-id="example-opened"]').click()
    expect(page.locator('h1')).to_be_in_viewport()
    assert not errors, errors
    print('PASS: complete creation, draft resume, validation, opening, result persistence, filters, search, sorting, export, file/link import, modal focus, widths 320/390/768/1440; no JavaScript errors')
    context.close()
    browser.close()
