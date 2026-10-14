import { openRepository } from './lib/repository.js?v=3';
import {
  getStatus,
  createCapsule,
  openCapsule,
  saveResult,
  exportJson,
  parseImport,
  exportMarkdown,
  encodeCapsule,
  decodeCapsule,
  localDate,
  reviewState,
  normalizeDraft as normalizeModelDraft,
} from './lib/model.js?v=3';
import { filterAndSortCapsules, summarizeArchive } from './lib/selectors.js?v=3';

const root = document.querySelector('#app');
const live = document.querySelector('#live-region');
const state = {
  repo: null,
  capsules: [],
  view: 'archive',
  filter: 'all',
  search: '',
  sort: 'review-asc',
  selectedId: null,
  wizardStep: 0,
  draft: blankDraft(),
  draftSaveStatus: 'saved',
  resultDrafts: new Map(),
  dialog: null,
  dialogTrigger: null,
  pendingImport: null,
  busyAction: null,
  toast: '',
  loading: true,
  today: localDate(new Date()),
};
let draftSaveTimer = null;
let draftSaveChain = Promise.resolve();
let draftRevision = 0;
let toastTimer = null;
let focusTimer = null;
let renderedPage = '';

function blankDraft() {
  return { question: '', context: '', options: ['', ''], chosenPath: '', confidence: 50, reviewDate: '' };
}
function normalizeDraft(value) {
  const normalized = normalizeModelDraft(value);
  while (normalized.options.length < 2) normalized.options.push('');
  return normalized;
}
function storedDraft() { return { ...state.draft, __step: state.wizardStep }; }
function draftHasContent() {
  return Boolean(state.draft.question.trim() || state.draft.context.trim() || state.draft.options.some((value) => value.trim()) || state.draft.chosenPath.trim() || state.draft.reviewDate);
}
function esc(value = '') { return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]); }
function text(value = '') { return esc(value).replace(/\n/g, '<br>'); }
function announce(message) { if (live) live.textContent = message; }
function today() { state.today = localDate(new Date()); return state.today; }
function formatDate(value) { if (!value) return 'не указана'; return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(new Date(`${value}T12:00:00`)); }
function formatDateTime(value) { if (!value) return 'не указана'; return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function numberFor(c) { return String(c.number ?? 0).padStart(3, '0'); }
function statusLabel(status) { return ({ sealed: 'запечатана', ready: 'готова к открытию', opened: 'открыта' })[status] ?? status; }
function statusClass(status) { return status === 'sealed' ? 'sealed' : status === 'opened' ? 'opened' : 'ready'; }
function currentCapsule() { return state.capsules.find((capsule) => capsule.id === state.selectedId); }
function plural(n, one, few, many) { const x = n % 10; const y = n % 100; return x === 1 && y !== 11 ? one : x >= 2 && x <= 4 && (y < 10 || y >= 20) ? few : many; }
function reviewMeta(capsule) {
  const timing = reviewState(capsule, state.today);
  if (timing.key === 'opened') return 'открыта';
  if (timing.key === 'due') return 'сегодня';
  if (timing.key === 'overdue') return `${Math.abs(timing.days)} ${plural(Math.abs(timing.days), 'день', 'дня', 'дней')} назад`;
  return `через ${timing.days} ${plural(timing.days, 'день', 'дня', 'дней')}`;
}
function friendlyError(error) {
  const map = {
    TOO_EARLY: 'эту капсулу можно открыть только в дату пересмотра или позже.',
    NOT_OPENED: 'сначала откройте капсулу, затем сохраните итог.',
    INVALID_HASH: 'ссылка повреждена или содержит неполные данные.',
    INVALID_EXPORT: 'файл не похож на архив этой версии.',
    INVALID_CAPSULE: 'в капсуле не хватает обязательного поля или оно имеет неверный формат.',
  };
  if (map[error?.code]) return map[error.code];
  if (typeof error?.message === 'string' && /[А-Яа-яЁё]/.test(error.message)) return error.message;
  return 'проверьте данные и повторите попытку.';
}
function notify(message) {
  announce(message);
  state.toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(clearToast, 3600);
  root.querySelector('.toast')?.remove();
  if (!state.loading) root.insertAdjacentHTML('beforeend', toastMarkup());
}
function clearToast() { clearTimeout(toastTimer); state.toast = ''; root.querySelector('.toast')?.remove(); }
function toastMarkup() { return state.toast ? `<div class="toast" role="status" aria-live="polite"><span>${esc(state.toast)}</span><button class="toast-close" data-action="close-toast" aria-label="закрыть уведомление">×</button></div>` : ''; }
function notifyError(error) { const message = friendlyError(error); announce(`ошибка: ${message}`); state.dialog = { type: 'message', title: 'не удалось выполнить действие', body: `<p class="error">${esc(message)}</p>` }; render(); }

async function init() {
  try {
    state.repo = await openRepository();
    state.capsules = await state.repo.list();
    const savedDraft = await state.repo.getDraft();
    if (savedDraft) {
      state.draft = normalizeDraft(savedDraft);
      state.wizardStep = Math.max(0, Math.min(Number.isInteger(savedDraft.__step) ? savedDraft.__step : 0, steps.length));
    }
    state.loading = false;
    const hashPayload = location.hash.startsWith('#capsule=') ? location.hash.slice('#capsule='.length) : '';
    if (hashPayload) {
      try { state.dialog = { type: 'hash', capsule: decodeCapsule(hashPayload), title: 'импорт по ссылке' }; }
      catch { state.dialog = { type: 'message', title: 'ссылка не распознана', body: '<p class="error">в ссылке нет корректной капсулы. архив не изменён.</p>', clearHash: true }; }
    }
    render();
  } catch (error) {
    state.loading = false;
    root.innerHTML = `<main class="main"><div class="notice notice-error"><strong>хранилище недоступно.</strong><p>${esc(error.message || 'разрешите хранение данных для этой страницы и повторите попытку.')}</p><button class="btn primary" data-action="retry">повторить</button></div></main>`;
  }
}

function shell(content) {
  return `<a class="skip-link" href="#main-content">к содержимому</a>
  <header class="app-header"><div class="app-header-inner">
    <button class="brand" data-action="archive" aria-label="decision capsule, открыть архив"><img class="brand-mark" src="assets/mark.svg" alt="" width="48" height="48"><span class="brand-title">decision capsule</span></button>
    ${state.view !== 'new' ? '<button class="btn primary" data-action="new"><span aria-hidden="true">＋</span> новая капсула</button>' : '<button class="btn ghost" data-action="archive">вернуться в архив</button>'}
  </div></header>
  <main class="main" id="main-content">${content}</main>
  <footer class="app-footer"><span class="local-dot" aria-hidden="true"></span> данные хранятся в этом браузере. скачайте архив, чтобы сохранить копию.</footer>
  ${toastMarkup()}`;
}

function archiveView() {
  const now = today();
  const counts = summarizeArchive(state.capsules, now);
  const filtered = filterAndSortCapsules(state.capsules, { today: now, filter: state.filter, search: state.search, sort: state.sort });
  const groups = state.filter === 'all'
    ? [['ready', 'готовы к открытию'], ['sealed', 'запечатанные'], ['opened', 'открытые']].map(([key, label]) => [key, label, filtered.filter((capsule) => getStatus(capsule, now) === key)]).filter(([, , items]) => items.length)
    : [[state.filter, '', filtered]];
  const emptyArchive = !state.capsules.length;
  const filterLabels = { all: 'все', sealed: 'запечатанные', ready: 'пора открыть', opened: 'открытые' };
  return shell(`<header class="topbar"><div class="topbar-copy"><h1>решения</h1><p>сохраните, что вы выбираете сейчас. вернитесь в назначенный день и запишите, что получилось.</p></div><div class="actions"><button class="btn ghost" data-action="export">скачать архив</button><button class="btn ghost" data-action="import">загрузить архив</button></div></header>
  <input id="import-file" type="file" accept="application/json,.json" hidden>
  ${draftHasContent() ? `<div class="draft-banner"><div><strong>вы начали капсулу</strong><span>черновик сохранён · шаг ${Math.min(state.wizardStep + 1, steps.length)} из ${steps.length}</span></div><div class="inline-actions"><button class="btn primary" data-action="resume-draft">продолжить</button><button class="text-button" data-action="clear-draft">удалить</button></div></div>` : ''}
  ${state.capsules.corrupted?.length ? `<div class="notice notice-error"><strong>не удалось прочитать ${state.capsules.corrupted.length} ${plural(state.capsules.corrupted.length, 'капсулу', 'капсулы', 'капсул')}.</strong><p>скачайте рабочие записи и восстановите повреждённые из резервной копии.</p></div>` : ''}
  ${!emptyArchive ? `<div class="filter-row"><div class="filter-tabs" role="group" aria-label="фильтр капсул">${['all', 'sealed', 'ready', 'opened'].map((key) => `<button data-action="filter" data-filter="${key}" aria-pressed="${state.filter === key}">${filterLabels[key]}<span class="filter-count">${counts[key]}</span></button>`).join('')}</div><div class="archive-tools"><div class="search-wrap"><label class="sr-only" for="search">поиск по архиву</label><input class="search" id="search" type="search" placeholder="найти решение" value="${esc(state.search)}">${state.search ? '<button class="clear-search" type="button" data-action="clear-search" aria-label="очистить поиск">×</button>' : ''}</div><label class="sort-wrap"><span class="sr-only">сортировка</span><select class="sort" id="sort"><option value="review-asc"${state.sort === 'review-asc' ? ' selected' : ''}>сначала ближайшие</option><option value="review-desc"${state.sort === 'review-desc' ? ' selected' : ''}>сначала дальние</option><option value="created-desc"${state.sort === 'created-desc' ? ' selected' : ''}>сначала новые</option><option value="created-asc"${state.sort === 'created-asc' ? ' selected' : ''}>сначала старые</option></select></label></div></div>` : ''}
  ${emptyArchive ? '<section class="empty empty-archive"><img class="empty-mark" src="assets/mark.svg" alt="" width="80" height="80"><h2>к какому решению вы хотите вернуться?</h2><p>запишите вопрос, варианты и свой выбор. позже сможете сравнить ожидания с тем, что произошло.</p><button class="btn primary" data-action="new">создать первую капсулу <span aria-hidden="true">↗</span></button></section>' : !filtered.length ? `<section class="empty"><h2>${state.search.trim() ? 'ничего не найдено' : 'здесь пока нет капсул'}</h2><p>${state.search.trim() ? `по запросу «${esc(state.search.trim())}» нет решений. попробуйте другие слова.` : state.filter === 'ready' ? 'когда наступит дата пересмотра, капсула появится здесь.' : state.filter === 'opened' ? 'здесь появятся капсулы, которые вы открыли.' : 'в архиве нет капсул с будущей датой пересмотра.'}</p><button class="btn ghost" data-action="${state.search.trim() ? 'clear-search' : 'filter'}"${state.search.trim() ? '' : ' data-filter="all"'}>${state.search.trim() ? 'очистить поиск' : 'показать все'}</button></section>` : groups.map(([, label, items]) => archiveSection(label, items)).join('')}`);
}
function archiveSection(label, items) {
  return `<section class="archive-section"${label ? '' : ' aria-label="капсулы"'}>${label ? `<div class="section-heading"><h2>${label}</h2></div>` : ''}<div class="capsule-grid">${items.map(card).join('')}</div></section>`;
}
function card(capsule) {
  const status = getStatus(capsule, state.today);
  const excerptSource = capsule.context || capsule.chosenPath || '';
  const excerpt = excerptSource.length > 130 ? `${excerptSource.slice(0, 130).trimEnd()}…` : excerptSource;
  return `<article class="capsule-card"><div class="card-body"><h3 class="card-question">${esc(capsule.question)}</h3>${excerpt ? `<p class="card-excerpt">${esc(excerpt)}</p>` : ''}<div class="card-meta"><span class="card-status ${statusClass(status)}">${statusLabel(status)}</span><span class="card-number">№ ${numberFor(capsule)}</span></div></div><div class="card-edge"><span class="review-label">пересмотр</span><time class="card-date" datetime="${esc(capsule.reviewDate)}">${formatDate(capsule.reviewDate)}</time><span class="review-meta ${reviewState(capsule, state.today).key}">${reviewMeta(capsule)}</span><button class="btn ghost" data-action="detail" data-id="${esc(capsule.id)}" aria-label="посмотреть капсулу: ${esc(capsule.question)}">посмотреть <span aria-hidden="true">↗</span></button></div></article>`;
}

const steps = [
  { key: 'question', title: 'какой вопрос нужно решить?', help: 'один конкретный вопрос, на который вы отвечаете сейчас.', label: 'вопрос', placeholder: 'например: менять ли формат работы этой осенью?' },
  { key: 'context', title: 'что важно учитывать?', help: 'что известно сейчас? какие обстоятельства влияют на выбор?', label: 'контекст', placeholder: 'что известно сейчас и какие есть ограничения?' },
  { key: 'options', title: 'какие варианты есть?', help: 'добавьте хотя бы два варианта, между которыми выбираете.', label: 'варианты' },
  { key: 'chosenPath', title: 'что вы выбираете?', help: 'назовите путь и коротко объясните выбор.', label: 'выбранный путь', placeholder: 'что именно вы выбираете и почему?' },
  { key: 'confidence', title: 'насколько вы уверены?', help: 'насколько вероятно, что выбранный путь даст нужный результат?', label: 'уверенность' },
  { key: 'reviewDate', title: 'когда вернуться к капсуле?', help: 'выберите день, когда уже сможете оценить результат. дата считается по часам устройства.', label: 'дата пересмотра' },
];
function progressMarkup() { return `<div class="progress" role="progressbar" aria-label="прогресс заполнения" aria-valuemin="1" aria-valuemax="${steps.length}" aria-valuenow="${state.wizardStep + 1}">${steps.map((_, index) => `<span class="${index <= state.wizardStep ? 'active' : ''}" aria-hidden="true"></span>`).join('')}</div>`; }
function draftStatusMarkup() { const labels = { saving: 'сохраняем…', saved: 'сохранено в браузере', error: 'не удалось сохранить' }; return `<span id="draft-status" class="save-status ${state.draftSaveStatus === 'error' ? 'error' : ''}">${labels[state.draftSaveStatus]}</span>`; }
function newView() {
  const step = steps[state.wizardStep];
  const confidence = Number.isFinite(Number(state.draft.confidence)) ? Number(state.draft.confidence) : 50;
  let field = '';
  if (step.key === 'question' || step.key === 'context' || step.key === 'chosenPath') field = `<div class="field"><label for="draft-${step.key}">${step.label}</label><textarea id="draft-${step.key}" data-draft="${step.key}" autofocus placeholder="${esc(step.placeholder)}">${esc(state.draft[step.key])}</textarea></div>`;
  if (step.key === 'options') field = `<div class="field"><span class="field-label">${step.label}</span><div class="option-list">${state.draft.options.map((option, index) => `<div class="option-row"><input aria-label="вариант ${index + 1}" data-option-index="${index}" value="${esc(option)}" placeholder="вариант ${index + 1}"${index === 0 ? ' autofocus' : ''}>${state.draft.options.length > 2 ? `<button class="text-button remove-option" type="button" data-action="remove-option" data-index="${index}" aria-label="удалить вариант ${index + 1}">удалить</button>` : ''}</div>`).join('')}</div><button class="btn ghost" type="button" data-action="add-option">добавить вариант</button></div>`;
  if (step.key === 'confidence') field = `<div class="field"><label for="draft-confidence">${step.label}</label><input id="draft-confidence" data-draft="confidence" type="range" min="0" max="100" step="5" value="${confidence}"><div class="range-meta"><span>0</span><strong id="confidence-value">${confidence}%</strong><span>100</span></div></div>`;
  if (step.key === 'reviewDate') { const min = today(); const value = state.draft.reviewDate || min; field = `<div class="field"><label for="draft-date">${step.label}</label><input id="draft-date" data-draft="reviewDate" type="date" min="${min}" value="${esc(value)}" autofocus><div class="preset-row"><button class="btn ghost" type="button" data-action="date-preset" data-days="7">через 7 дней</button><button class="btn ghost" type="button" data-action="date-preset" data-days="30">через 30 дней</button><button class="btn ghost" type="button" data-action="date-preset" data-days="365">через год</button></div></div>`; }
  return shell(`<div class="wizard-layout"><div class="page-heading"><h1>${step.title}</h1><p>${step.help}</p></div><form class="form-frame" id="capsule-form"><div class="form-meta"><span>шаг ${state.wizardStep + 1} из ${steps.length}</span>${draftStatusMarkup()}</div>${progressMarkup()}${field}<div id="form-error" class="error" role="alert"></div><div class="form-actions"><button class="btn ghost" type="button" data-action="prev"${state.wizardStep === 0 ? ' disabled' : ''}>назад</button><button class="btn primary" type="submit">${state.wizardStep === steps.length - 1 ? 'проверить капсулу' : 'продолжить'} <span aria-hidden="true">→</span></button></div></form></div>`);
}
function summaryRows(capsule) { return `<div class="summary-row"><dt>контекст</dt><dd>${text(capsule.context)}</dd></div><div class="summary-row"><dt>варианты</dt><dd><ol class="decision-options">${capsule.options.map((option) => `<li>${esc(option)}</li>`).join('')}</ol></dd></div><div class="summary-row"><dt>выбранный путь</dt><dd>${text(capsule.chosenPath)}</dd></div><div class="summary-row"><dt>уверенность</dt><dd>${Number(capsule.confidence)}%</dd></div><div class="summary-row"><dt>дата пересмотра</dt><dd>${formatDate(capsule.reviewDate)}</dd></div>`; }
function reviewView() { const d = state.draft; return shell(`<div class="wizard-layout review-layout"><div class="page-heading"><h1>всё верно?</h1><p>после запечатывания вопрос, контекст и выбор останутся такими, как сейчас. при открытии вы сможете добавить итог.</p></div><section class="envelope"><h2 class="review-question">${esc(d.question)}</h2><dl class="summary">${summaryRows(d)}</dl></section><div class="form-actions"><button class="btn ghost" data-action="edit-draft">изменить</button><button class="btn primary" data-action="seal"${state.busyAction ? ' disabled' : ''}>${state.busyAction === 'seal' ? 'сохраняем…' : 'запечатать капсулу'}</button></div></div>`); }
function detailView(capsule) {
  const status = getStatus(capsule, state.today); const opened = Boolean(capsule.openedAt); const canOpen = status === 'ready' && !opened;
  return shell(`<button class="back" data-action="archive">← все решения</button><div class="page-heading detail-heading"><h1>${esc(capsule.question)}</h1><div class="detail-meta"><span class="card-status ${statusClass(status)}">${statusLabel(status)}</span><span class="card-number">капсула № ${numberFor(capsule)}</span></div></div><div class="detail-layout"><section><div class="envelope"><dl class="summary">${summaryRows(capsule)}</dl></div>${canOpen ? '<div class="notice open-notice"><div><strong>можно вернуться к решению</strong><p>дата пересмотра наступила. откройте капсулу и запишите итог.</p></div><button class="btn primary" data-action="open" data-id="' + esc(capsule.id) + '">открыть капсулу</button></div>' : ''}${!opened && !canOpen ? `<div class="notice"><strong>открыть можно ${formatDate(capsule.reviewDate)}</strong><p>тогда появится поле для итога. исходное решение уже сохранено.</p></div>` : ''}${opened ? resultForm(capsule) : ''}</section><aside class="detail-aside"><div><strong>запечатана</strong><span>${formatDateTime(capsule.sealedAt)}</span></div><div><strong>вернуться к решению</strong><span>${formatDate(capsule.reviewDate)}</span></div>${capsule.openedAt ? `<div><strong>открыта</strong><span>${formatDateTime(capsule.openedAt)}</span></div>` : ''}<div class="aside-actions"><button class="btn ghost" data-action="share" data-id="${esc(capsule.id)}">ссылка на капсулу</button><button class="btn ghost" data-action="markdown" data-id="${esc(capsule.id)}">скачать заметку</button></div></aside></div>`);
}
function resultStatus(capsule) {
  if (state.resultDrafts.has(capsule.id) && state.resultDrafts.get(capsule.id) !== (capsule.result || '')) return 'изменения не сохранены';
  return capsule.result ? `сохранено ${formatDateTime(capsule.resultUpdatedAt)}` : 'пока не сохранён';
}
function resultForm(capsule) {
  const hasResult = Boolean(capsule.result);
  const value = state.resultDrafts.get(capsule.id) ?? capsule.result ?? '';
  return `<div class="result-box"><h2>фактический итог</h2><p>что произошло и что вы узнали?</p><form id="result-form"><div class="field"><label for="result">итог</label><textarea id="result" autofocus placeholder="запишите наблюдение">${esc(value)}</textarea></div><div id="result-error" class="error" role="alert"></div><div class="form-actions"><span id="result-status" class="save-status">${resultStatus(capsule)}</span><div class="right"><button class="btn primary" type="submit"${state.busyAction === 'result' ? ' disabled' : ''}>${state.busyAction === 'result' ? 'сохраняем…' : hasResult ? 'сохранить итог' : 'добавить итог'}</button></div></div></form></div>`;
}

function render({ focus = true } = {}) {
  clearTimeout(focusTimer);
  state.today = localDate(new Date());
  if (state.loading) { root.innerHTML = '<main class="main"><div class="notice">открываем архив…</div></main>'; return; }
  const page = `${state.view}:${state.selectedId || ''}:${state.view === 'new' ? state.wizardStep : ''}`;
  const changedPage = page !== renderedPage;
  renderBase();
  renderedPage = page;
  if (changedPage) window.scrollTo(0, 0);
  if (state.dialog) renderDialog(); else if (focus) focusAfterRender(changedPage);
}
function renderBase() { if (state.view === 'new') root.innerHTML = state.wizardStep >= steps.length ? reviewView() : newView(); else if (state.view === 'detail' && currentCapsule()) root.innerHTML = detailView(currentCapsule()); else root.innerHTML = archiveView(); }
function focusAfterRender(changedPage) { const target = (changedPage && state.view === 'detail' ? null : window.matchMedia?.('(pointer: fine)').matches ? root.querySelector('[autofocus]') : null) || root.querySelector('main h1'); if (target) { if (target.matches('h1')) target.tabIndex = -1; focusTimer = setTimeout(() => target.focus({ preventScroll: true }), 0); } }
function renderDialog() {
  const dialog = state.dialog; let body = '';
  if (dialog.type === 'message') body = `${dialog.body}<div class="dialog-actions"><button class="btn primary" data-action="close-dialog">понятно</button></div>`;
  if (dialog.type === 'hash') body = `<p>ссылка содержит одну капсулу. архив изменится только после подтверждения.</p><div class="envelope compact-envelope"><h2 class="card-question">${esc(dialog.capsule.question)}</h2><p>${text(dialog.capsule.context)}</p><p class="mono">пересмотр: ${formatDate(dialog.capsule.reviewDate)}</p></div><div class="notice">любой, у кого есть ссылка, сможет прочитать капсулу. данные в ссылке не зашифрованы.</div><div class="dialog-actions"><button class="btn ghost" data-action="close-dialog">отмена</button><button class="btn primary" data-action="import-hash"${state.busyAction === 'import-hash' ? ' disabled' : ''}>${state.busyAction === 'import-hash' ? 'добавляем…' : 'добавить в архив'}</button></div>`;
  if (dialog.type === 'share') body = `<p>по этой ссылке можно перенести капсулу в другой браузер или поделиться ею.</p><textarea class="url-copy" readonly aria-label="ссылка для копирования">${esc(dialog.url)}</textarea><div class="notice">любой, у кого есть ссылка, сможет прочитать капсулу. данные в ссылке не зашифрованы.</div><div class="dialog-actions"><button class="btn ghost" data-action="close-dialog">закрыть</button><button class="btn primary" data-action="copy-url">скопировать</button></div>`;
  if (dialog.type === 'import') body = `<p>выберите json-файл, скачанный из decision capsule. перед добавлением вы увидите, сколько в нём новых капсул. существующие записи останутся на месте.</p><div class="dialog-actions"><button class="btn ghost" data-action="close-dialog">отмена</button><button class="btn primary" data-action="pick-import">выбрать файл</button></div>`;
  if (dialog.type === 'import-preview') body = `<p>файл проверен. архив изменится только после подтверждения.</p><div class="import-summary"><div><strong>${dialog.fresh}</strong><span>${plural(dialog.fresh, 'новая капсула', 'новые капсулы', 'новых капсул')}</span></div><div><strong>${dialog.duplicates}</strong><span>уже в архиве</span></div></div><div class="dialog-actions"><button class="btn ghost" data-action="close-dialog">отмена</button><button class="btn primary" data-action="confirm-import"${dialog.fresh && !state.busyAction ? '' : ' disabled'}>${state.busyAction === 'confirm-import' ? 'добавляем…' : 'добавить новые'}</button></div>`;
  if (dialog.type === 'draft-choice') body = `<p>в архиве уже есть незавершённый черновик.</p><div class="dialog-actions"><button class="btn ghost" data-action="resume-draft">продолжить черновик</button><button class="btn primary" data-action="start-new">начать новую</button></div>`;
  if (dialog.type === 'clear-draft') body = `<p>черновик будет удалён с этого устройства.</p><div class="dialog-actions"><button class="btn ghost" data-action="close-dialog">оставить</button><button class="btn primary" data-action="confirm-clear-draft">удалить черновик</button></div>`;
  if (dialog.type === 'open-confirm') body = `<p>дата пересмотра наступила. после открытия исходные данные останутся неизменными.</p><div class="dialog-actions"><button class="btn ghost" data-action="close-dialog">отмена</button><button class="btn primary" data-action="confirm-open" data-id="${esc(dialog.capsule.id)}"${state.busyAction === 'confirm-open' ? ' disabled' : ''}>${state.busyAction === 'confirm-open' ? 'открываем…' : 'открыть капсулу'}</button></div>`;
  root.insertAdjacentHTML('beforeend', `<div class="dialog-backdrop" data-action="backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description"><h2 id="dialog-title">${esc(dialog.title || 'действие')}</h2><div id="dialog-description">${body}</div></section></div>`);
  setTimeout(() => root.querySelector('.dialog button, .dialog textarea')?.focus(), 0);
}
function closeDialog({ clearHash = false } = {}) {
  const trigger = state.dialogTrigger;
  if (state.dialog?.type === 'import-preview') state.pendingImport = null;
  state.dialog = null;
  state.dialogTrigger = null;
  if (clearHash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  render();
  if (!trigger) return;
  setTimeout(() => {
    const target = [...root.querySelectorAll('[data-action]')].find((element) => element.dataset.action === trigger.action && (!trigger.id || element.dataset.id === trigger.id));
    target?.focus();
  }, 0);
}
function openDialog(dialog, trigger = document.activeElement) {
  state.dialog = dialog;
  state.dialogTrigger = trigger?.dataset?.action ? { action: trigger.dataset.action, id: trigger.dataset.id || '' } : null;
  render();
}
function focusables() { return [...root.querySelectorAll('.dialog button, .dialog textarea, .dialog input, .dialog select, .dialog [href]')].filter((el) => !el.disabled); }

function setDraftFromForm() {
  root.querySelectorAll('[data-draft]').forEach((element) => { const key = element.dataset.draft; state.draft[key] = key === 'confidence' ? Number(element.value) : element.value; });
  const options = [...root.querySelectorAll('[data-option-index]')];
  if (options.length) state.draft.options = options.map((element) => element.value);
}
function setDraftStatus(status) { state.draftSaveStatus = status; const element = document.querySelector('#draft-status'); if (element) { element.textContent = status === 'saving' ? 'сохраняем…' : status === 'error' ? 'не удалось сохранить' : 'сохранено в браузере'; element.classList.toggle('error', status === 'error'); } }
function scheduleDraftSave() {
  if (!state.repo) return;
  clearTimeout(draftSaveTimer); const revision = ++draftRevision; setDraftStatus('saving');
  draftSaveTimer = setTimeout(() => { draftSaveTimer = null; const snapshot = storedDraft(); draftSaveChain = draftSaveChain.catch(() => {}).then(() => state.repo.setDraft(snapshot)).then(() => { if (revision === draftRevision) setDraftStatus('saved'); }, () => { if (revision === draftRevision) setDraftStatus('error'); }); }, 240);
}
async function flushDraftSave() {
  clearTimeout(draftSaveTimer); draftSaveTimer = null; const revision = ++draftRevision; const snapshot = storedDraft(); setDraftStatus('saving');
  draftSaveChain = draftSaveChain.catch(() => {}).then(() => state.repo.setDraft(snapshot)).then(() => { if (revision === draftRevision) setDraftStatus('saved'); });
  await draftSaveChain;
}
async function clearDraftAndReset() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  draftRevision += 1;
  await draftSaveChain.catch(() => {});
  await state.repo.clearDraft();
  state.draft = blankDraft();
  state.wizardStep = 0;
  state.draftSaveStatus = 'saved';
}
function validateStep() {
  const d = state.draft;
  const key = steps[state.wizardStep].key;
  if (key === 'question' && !d.question.trim()) return 'сформулируйте вопрос.';
  if (key === 'context' && !d.context.trim()) return 'добавьте контекст.';
  if (key === 'options') {
    d.options = d.options.map((value) => value.trim()).filter(Boolean);
    while (d.options.length < 2) d.options.push('');
    if (d.options.filter(Boolean).length < 2) return 'добавьте минимум два варианта.';
  }
  if (key === 'chosenPath' && !d.chosenPath.trim()) return 'укажите выбранный путь.';
  if (key === 'reviewDate' && (!d.reviewDate || d.reviewDate < today() || Number.isNaN(new Date(`${d.reviewDate}T12:00:00`).getTime()))) return 'выберите сегодняшнюю или будущую дату.';
  return '';
}
function addDays(date, days) { const [year, month, day] = date.split('-').map(Number); const next = new Date(year, month - 1, day, 12); next.setDate(next.getDate() + Number(days)); return localDate(next); }
function clearHash() { history.replaceState(null, '', `${location.pathname}${location.search}`); }
function download(blob, filename) { const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
async function refresh() { state.capsules = await state.repo.list(); state.today = localDate(new Date()); }
async function sealDraft() { const nextNumber = Math.max(0, ...state.capsules.map((capsule) => Number(capsule.number) || 0)) + 1; const capsule = createCapsule({ ...state.draft, number: nextNumber }); if (typeof state.repo.sealCapsule === 'function') return state.repo.sealCapsule(capsule, storedDraft()); await state.repo.addCapsule(capsule); await state.repo.clearDraft(); return capsule; }

root.addEventListener('click', async (event) => {
  const actionElement = event.target.closest('[data-action]'); if (!actionElement) return; const action = actionElement.dataset.action;
  const busyAction = ['seal', 'confirm-open', 'confirm-import', 'import-hash'].includes(action) ? action : null;
  if (busyAction) {
    if (state.busyAction) return;
    state.busyAction = busyAction;
    render();
  }
  try {
    if (action === 'backdrop') { if (event.target === actionElement) closeDialog({ clearHash: state.dialog?.type === 'hash' || state.dialog?.clearHash }); return; }
    if (action === 'retry') { state.loading = true; render(); await init(); return; }
    if (action === 'close-toast') { clearToast(); return; }
    if (action === 'new') { if (draftHasContent()) { openDialog({ type: 'draft-choice', title: 'незавершённый черновик' }, actionElement); } else { state.view = 'new'; state.draft = blankDraft(); state.wizardStep = 0; render(); } return; }
    if (action === 'resume-draft') { state.dialog = null; state.dialogTrigger = null; state.view = 'new'; render(); return; }
    if (action === 'start-new') { await clearDraftAndReset(); state.dialog = null; state.dialogTrigger = null; state.view = 'new'; render(); return; }
    if (action === 'clear-draft') { openDialog({ type: 'clear-draft', title: 'удалить черновик?' }, actionElement); return; }
    if (action === 'confirm-clear-draft') { await clearDraftAndReset(); closeDialog(); notify('черновик удалён.'); return; }
    if (action === 'archive') { if (state.view === 'new') { setDraftFromForm(); await flushDraftSave(); } state.view = 'archive'; state.selectedId = null; render(); return; }
    if (action === 'filter') { state.filter = actionElement.dataset.filter; state.view = 'archive'; render(); return; }
    if (action === 'detail') { state.selectedId = actionElement.dataset.id; state.view = 'detail'; render(); return; }
    if (action === 'prev') { setDraftFromForm(); state.wizardStep = Math.max(0, state.wizardStep - 1); await flushDraftSave(); render(); return; }
    if (action === 'edit-draft') { state.wizardStep = steps.length - 1; state.view = 'new'; await flushDraftSave(); render(); return; }
    if (action === 'clear-search') { state.search = ''; render(); return; }
    if (action === 'add-option') { setDraftFromForm(); state.draft.options.push(''); scheduleDraftSave(); render(); return; }
    if (action === 'remove-option') { setDraftFromForm(); if (state.draft.options.length > 2) state.draft.options.splice(Number(actionElement.dataset.index), 1); scheduleDraftSave(); render(); return; }
    if (action === 'date-preset') { state.draft.reviewDate = addDays(today(), actionElement.dataset.days); scheduleDraftSave(); render(); return; }
    if (action === 'seal') { await flushDraftSave(); const capsule = await sealDraft(); await refresh(); state.draft = blankDraft(); state.wizardStep = 0; state.selectedId = capsule.id; state.view = 'detail'; notify('капсула запечатана.'); return; }
    if (action === 'open') { const capsule = currentCapsule(); if (!capsule) { state.view = 'archive'; render(); return; } openDialog({ type: 'open-confirm', title: 'открыть капсулу?', capsule }, actionElement); return; }
    if (action === 'confirm-open') { const capsule = currentCapsule(); const opened = openCapsule(capsule, new Date()); await state.repo.updateProgress(capsule.id, { openedAt: opened.openedAt }); await refresh(); closeDialog(); notify('капсула открыта.'); return; }
    if (action === 'export') { download(new Blob([exportJson(state.capsules)], { type: 'application/json' }), `decision-capsules-${today()}.json`); notify('архив готов к скачиванию.'); return; }
    if (action === 'import') { openDialog({ type: 'import', title: 'импорт архива' }, actionElement); return; }
    if (action === 'pick-import') { document.querySelector('#import-file')?.click(); return; }
    if (action === 'close-dialog') { closeDialog({ clearHash: state.dialog?.type === 'hash' || state.dialog?.clearHash }); return; }
    if (action === 'import-hash') { const incoming = state.dialog.capsule; const result = await state.repo.importCapsules([incoming]); await refresh(); closeDialog({ clearHash: true }); notify(result.imported ? 'капсула добавлена в архив.' : 'такая капсула уже есть в архиве.'); return; }
    if (action === 'confirm-import') { const incoming = state.pendingImport || []; const result = await state.repo.importCapsules(incoming); await refresh(); state.pendingImport = null; closeDialog(); notify(`добавлено: ${result.imported}. пропущено: ${result.skipped}.`); return; }
    if (action === 'share') { const capsule = state.capsules.find((item) => item.id === actionElement.dataset.id); const url = `${location.origin}${location.pathname}#capsule=${encodeCapsule(capsule)}`; openDialog({ type: 'share', title: 'ссылка на капсулу', url }, actionElement); return; }
    if (action === 'copy-url') { const area = root.querySelector('.url-copy'); try { await navigator.clipboard.writeText(area?.value || ''); notify('ссылка скопирована.'); } catch { area?.focus(); area?.select(); notify('ссылка выделена. нажмите Cmd/Ctrl+C.'); } return; }
    if (action === 'markdown') { const capsule = state.capsules.find((item) => item.id === actionElement.dataset.id); download(new Blob([exportMarkdown([capsule])], { type: 'text/markdown;charset=utf-8' }), `decision-capsule-${numberFor(capsule)}.md`); notify('заметка готова к скачиванию.'); return; }
  } catch (error) { notifyError(error); }
  finally { if (busyAction && state.busyAction === busyAction) { state.busyAction = null; render(); } }
});

root.addEventListener('input', (event) => {
  const element = event.target;
  if (element.matches('#search')) {
    if (event.isComposing) return;
    const caret = element.selectionStart ?? element.value.length;
    state.search = element.value;
    render({ focus: false });
    const next = document.querySelector('#search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
    return;
  }
  if (element.matches('#result')) { const capsule = currentCapsule(); if (capsule) { state.resultDrafts.set(capsule.id, element.value); const status = document.querySelector('#result-status'); if (status) status.textContent = resultStatus(capsule); } return; }
  if (element.matches('[data-draft], [data-option-index]')) { setDraftFromForm(); if (element.matches('[data-draft="confidence"]')) { const output = document.querySelector('#confidence-value'); if (output) output.textContent = `${element.value}%`; } scheduleDraftSave(); }
});
root.addEventListener('compositionend', (event) => {
  if (!event.target.matches('#search')) return;
  state.search = event.target.value;
  render({ focus: false });
  document.querySelector('#search')?.focus();
});
root.addEventListener('change', (event) => { if (event.target.matches('#sort')) { state.sort = event.target.value; render(); } });
root.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submittedResult = event.target.id === 'result-form' ? (document.querySelector('#result')?.value || '') : '';
  if (event.target.id === 'result-form' && !submittedResult.trim()) {
    const box = document.querySelector('#result-error');
    if (box) box.textContent = 'добавьте итог или наблюдение.';
    document.querySelector('#result')?.focus();
    return;
  }
  if (event.target.id === 'result-form') {
    if (state.busyAction) return;
    state.busyAction = 'result';
    render();
  }
  try {
    if (event.target.id === 'capsule-form') { setDraftFromForm(); const error = validateStep(); const box = document.querySelector('#form-error'); if (box) box.textContent = error; if (error) { announce(error); root.querySelector('[data-draft], [data-option-index]')?.focus(); return; } state.wizardStep += 1; await flushDraftSave(); render(); return; }
    if (event.target.id === 'result-form') { const capsule = currentCapsule(); const value = submittedResult.trim(); const saved = saveResult(capsule, value, new Date()); await state.repo.updateProgress(capsule.id, { result: saved.result, resultUpdatedAt: saved.resultUpdatedAt }); await refresh(); if (state.resultDrafts.get(capsule.id) === submittedResult) state.resultDrafts.delete(capsule.id); notify('итог сохранён.'); }
  } catch (error) { notifyError(error); }
  finally { if (state.busyAction === 'result') { state.busyAction = null; render(); } }
});
document.addEventListener('change', async (event) => {
  if (!event.target.matches('#import-file')) return; const file = event.target.files?.[0]; if (!file) return;
  try {
    const parsed = parseImport(await file.text());
    const existing = new Set(state.capsules.map((capsule) => capsule.id));
    const unique = new Set();
    const duplicates = parsed.filter((capsule) => existing.has(capsule.id) || unique.has(capsule.id)).length;
    parsed.forEach((capsule) => unique.add(capsule.id));
    state.pendingImport = parsed;
    state.dialog = { type: 'import-preview', title: 'проверить импорт', fresh: parsed.length - duplicates, duplicates };
    render();
  }
  catch (error) { state.dialog = { type: 'message', title: 'импорт не выполнен', body: `<p class="error">${esc(friendlyError(error))}</p>` }; render(); }
  event.target.value = '';
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && state.view === 'new' && state.repo) {
    setDraftFromForm();
    flushDraftSave().catch(() => setDraftStatus('error'));
  }
  if (document.visibilityState === 'visible' && state.repo && state.view !== 'new') {
    refresh().then(() => render()).catch(() => {});
  }
});
document.addEventListener('keydown', (event) => {
  if (!state.dialog) return;
  if (event.key === 'Escape') { event.preventDefault(); closeDialog({ clearHash: state.dialog.type === 'hash' || state.dialog.clearHash }); return; }
  if (event.key !== 'Tab') return; const nodes = focusables(); if (!nodes.length) return; const first = nodes[0]; const last = nodes[nodes.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
window.addEventListener('hashchange', () => { if (!location.hash) { if (state.dialog?.type === 'hash' || state.dialog?.clearHash) closeDialog(); return; } if (!location.hash.startsWith('#capsule=')) return; try { openDialog({ type: 'hash', capsule: decodeCapsule(location.hash), title: 'импорт по ссылке' }); } catch { openDialog({ type: 'message', title: 'ссылка не распознана', body: '<p class="error">в ссылке нет корректной капсулы.</p>', clearHash: true }); } });
setInterval(() => { const next = localDate(new Date()); if (next !== state.today) { state.today = next; if (state.view !== 'new') render(); } }, 60_000);

init();
