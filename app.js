import { openRepository } from './lib/repository.js?v=2';
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
} from './lib/model.js?v=2';
import { filterAndSortCapsules, summarizeArchive } from './lib/selectors.js?v=2';

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
function formatDate(value) { if (!value) return '—'; return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(new Date(`${value}T12:00:00`)); }
function formatDateTime(value) { if (!value) return '—'; return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
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
function reviewDescription(capsule) {
  const timing = reviewState(capsule, state.today);
  if (timing.key === 'opened') return 'капсула открыта. добавьте фактический итог, когда он появится.';
  if (timing.key === 'due') return 'дата пересмотра наступила.';
  if (timing.key === 'overdue') return `дата пересмотра прошла ${reviewMeta(capsule)}.`;
  return `запечатано до ${formatDate(capsule.reviewDate)}.`;
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
  toastTimer = setTimeout(() => { state.toast = ''; if (!state.loading) render(); }, 3600);
  if (!state.loading) render();
}
function clearToast() { clearTimeout(toastTimer); state.toast = ''; render(); }
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
    root.innerHTML = `<main class="main"><div class="notice notice-error"><strong>хранилище недоступно.</strong><p>${esc(error.message || 'разрешите IndexedDB для этой страницы и повторите попытку.')}</p><button class="btn primary" data-action="retry">повторить</button></div></main>`;
  }
}

function shell(content) {
  const counts = summarizeArchive(state.capsules, state.today);
  const navItems = [['all', 'все капсулы'], ['sealed', 'запечатанные'], ['ready', 'готовы к открытию'], ['opened', 'открытые']];
  return `<a class="skip-link" href="#main-content">к содержимому</a><aside class="sidebar">
    <div class="brand"><div class="brand-mark" aria-hidden="true">DC</div><div><div class="brand-title">архив решений</div><div class="brand-note">локальные капсулы с датой пересмотра</div></div></div>
    <nav class="nav" aria-label="разделы архива">${navItems.map(([key, label]) => `<button data-action="filter" data-filter="${key}"${state.view === 'archive' && state.filter === key ? ' aria-current="page"' : ''}><span>${label}</span><span class="nav-count">${counts[key]}</span></button>`).join('')}</nav>
    <div class="sidebar-footer"><span class="mono">только на этом устройстве</span><span>дата пересмотра считается по локальным часам.</span></div>
  </aside><main class="main" id="main-content">${content}</main>${state.toast ? `<div class="toast" role="status" aria-live="polite"><span>${esc(state.toast)}</span><button class="toast-close" data-action="close-toast" aria-label="закрыть уведомление">×</button></div>` : ''}`;
}

function archiveView() {
  const now = today();
  const counts = summarizeArchive(state.capsules, now);
  const filtered = filterAndSortCapsules(state.capsules, { today: now, filter: state.filter, search: state.search, sort: state.sort });
  const groups = state.filter === 'all'
    ? [['ready', 'готовы к открытию'], ['sealed', 'запечатанные'], ['opened', 'открытые']].map(([key, label]) => [key, label, filtered.filter((capsule) => getStatus(capsule, now) === key)])
    : [[state.filter, statusLabel(state.filter), filtered]];
  const hasDraft = draftHasContent();
  const resultLabel = state.search.trim() || state.filter !== 'all' ? `${filtered.length} ${plural(filtered.length, 'капсула', 'капсулы', 'капсул')}` : `${counts.all} ${plural(counts.all, 'капсула', 'капсулы', 'капсул')}`;
  const emptyArchive = !state.capsules.length && !state.search.trim() && state.filter === 'all';
  const emptyFilter = !emptyArchive && !filtered.length;
  const emptyFilterActions = state.search.trim()
    ? '<button class="btn ghost" data-action="clear-search">очистить поиск</button>'
    : '<button class="btn ghost" data-action="filter" data-filter="all">показать все</button>';
  return shell(`<header class="topbar"><div class="topbar-copy"><div class="archive-kicker"><span class="eyebrow">личный архив</span><span class="folio mono">${formatDate(now)} · ${resultLabel}</span></div><h1>решения</h1><p>запишите вопрос, назначьте дату и вернитесь к нему с фактическим итогом.</p></div><div class="actions"><button class="btn primary" data-action="new">новая капсула</button><button class="btn ghost" data-action="export">экспорт JSON</button><button class="btn ghost" data-action="import">импорт</button><input id="import-file" type="file" accept="application/json,.json" hidden></div></header>
  ${hasDraft ? `<div class="draft-banner"><div><strong>есть незавершённый черновик.</strong><span>шаг ${Math.min(state.wizardStep + 1, steps.length)} из ${steps.length}</span></div><div class="inline-actions"><button class="btn primary" data-action="resume-draft">продолжить</button><button class="btn text-button" data-action="clear-draft">удалить черновик</button></div></div>` : ''}
  ${state.capsules.corrupted?.length ? `<div class="notice notice-error"><strong>${state.capsules.corrupted.length} повреждённая ${plural(state.capsules.corrupted.length, 'капсула пропущена', 'капсулы пропущены', 'капсул пропущено')}.</strong><p>она не показана в архиве. экспортируйте рабочие капсулы и восстановите её из резервной копии.</p></div>` : ''}
  ${counts.ready ? `<div class="notice"><strong>${counts.ready} ${plural(counts.ready, 'капсула готова', 'капсулы готовы', 'капсул готовы')}.</strong> откройте её вручную, когда будете готовы.</div>` : ''}
  <div class="summary-strip" aria-label="состояние архива"><div><span class="mono">всего</span><strong>${counts.all}</strong></div><div class="summary-ready"><span class="mono">готовы</span><strong>${counts.ready}</strong></div><div><span class="mono">открыты</span><strong>${counts.opened}</strong></div></div>
  <div class="filter-row"><div class="filter-tabs" role="group" aria-label="фильтр капсул">${['all','sealed','ready','opened'].map((key) => `<button data-action="filter" data-filter="${key}" aria-pressed="${state.filter === key}">${key === 'all' ? 'все' : statusLabel(key)}</button>`).join('')}</div><label class="search-wrap"><span class="sr-only">поиск по архиву</span><input class="search" id="search" type="search" placeholder="поиск по архиву" value="${esc(state.search)}">${state.search ? '<button class="clear-search" type="button" data-action="clear-search">очистить</button>' : ''}</label><label class="sort-wrap"><span class="sr-only">сортировка</span><select class="sort" id="sort"><option value="review-asc"${state.sort === 'review-asc' ? ' selected' : ''}>сначала ближайшие</option><option value="review-desc"${state.sort === 'review-desc' ? ' selected' : ''}>сначала дальние</option><option value="created-desc"${state.sort === 'created-desc' ? ' selected' : ''}>сначала новые</option><option value="created-asc"${state.sort === 'created-asc' ? ' selected' : ''}>сначала старые</option></select></label></div>
  ${emptyArchive ? '<section class="empty empty-archive"><h2>архив пока пуст</h2><p>создайте первую капсулу: вопрос, варианты, выбранный путь и дата пересмотра.</p><button class="btn primary" data-action="new">новая капсула</button></section>' : emptyFilter ? `<section class="empty empty-archive"><h2>ничего не найдено</h2><p>${state.search.trim() ? `по запросу «${esc(state.search.trim())}» нет капсул.` : `в разделе «${esc(statusLabel(state.filter))}» пока нет капсул.`}</p><div class="inline-actions">${emptyFilterActions}</div></section>` : groups.map(([key, label, items]) => archiveSection(key, label, items, Boolean(state.search.trim()))).join('')}`, 'архив решений');
}
function archiveSection(key, label, items, searching) {
  const emptyTitle = searching ? 'ничего не найдено' : key === 'ready' ? 'нет капсул к открытию' : key === 'opened' ? 'нет открытых капсул' : 'архив пуст';
  const emptyText = searching ? 'измените запрос или очистите поиск.' : key === 'sealed' ? 'создайте капсулу и назначьте дату пересмотра.' : key === 'ready' ? 'капсулы появятся здесь в назначенную дату.' : key === 'opened' ? 'откройте готовую капсулу, чтобы добавить итог.' : 'создайте первую капсулу.';
  return `<section class="archive-section"><div class="section-heading"><h2>${label}</h2><span class="mono">${items.length} ${plural(items.length, 'капсула', 'капсулы', 'капсул')}</span></div>${items.length ? `<div class="capsule-grid">${items.map(card).join('')}</div>` : `<div class="empty"><h3>${emptyTitle}</h3><p>${emptyText}</p>${!searching && key === 'sealed' ? '<button class="btn primary" data-action="new">новая капсула</button>' : ''}</div>`}</section>`;
}
function card(capsule) {
  const status = getStatus(capsule, state.today);
  const excerptSource = capsule.context || capsule.chosenPath || '';
  const excerpt = excerptSource.length > 130 ? `${excerptSource.slice(0, 130).trimEnd()}…` : excerptSource;
  return `<article class="capsule-card"><div class="card-index"><span class="mono">№</span><strong>${numberFor(capsule)}</strong></div><div class="card-body"><div class="card-status ${statusClass(status)}">${statusLabel(status)}</div><h3 class="card-question">${esc(capsule.question)}</h3>${excerpt ? `<p class="card-excerpt">${esc(excerpt)}</p>` : ''}</div><div class="card-edge"><span class="review-label mono">пересмотр</span><time class="card-date" datetime="${esc(capsule.reviewDate)}">${formatDate(capsule.reviewDate)}</time><span class="review-meta ${reviewState(capsule, state.today).key}">${reviewMeta(capsule)}</span><button class="btn ghost" data-action="detail" data-id="${esc(capsule.id)}">просмотреть</button></div></article>`;
}

function stampMarkup(label, number, opened = false) {
  return `<svg class="envelope-stamp-svg${opened ? ' stamp-opened' : ''}" viewBox="0 0 100 100" role="img" aria-label="${esc(label)} № ${esc(number)}"><circle cx="50" cy="50" r="39"></circle><circle cx="50" cy="50" r="33" stroke-dasharray="2 3"></circle><text x="50" y="46">${esc(label)}</text><text x="50" y="58">№ ${esc(number)}</text></svg>`;
}

const steps = [
  { key: 'question', title: 'какой вопрос нужно решить?', help: 'один конкретный вопрос, на который вы отвечаете сейчас.', label: 'вопрос', placeholder: 'например: менять ли формат работы этой осенью?' },
  { key: 'context', title: 'что важно учитывать?', help: 'факты, ограничения, сроки и сигналы, которые влияют на решение.', label: 'контекст', placeholder: 'что известно сейчас и какие есть ограничения?' },
  { key: 'options', title: 'какие варианты есть?', help: 'запишите минимум два реальных пути.', label: 'варианты' },
  { key: 'chosenPath', title: 'что вы выбираете?', help: 'назовите путь и коротко объясните выбор.', label: 'выбранный путь', placeholder: 'что именно вы выбираете и почему?' },
  { key: 'confidence', title: 'насколько вы уверены?', help: 'отметка для сравнения с будущим опытом.', label: 'уверенность' },
  { key: 'reviewDate', title: 'когда вернуться к капсуле?', help: 'дата считается по локальным часам устройства.', label: 'дата пересмотра' },
];
function progressMarkup() { return `<div class="progress" role="progressbar" aria-label="прогресс заполнения" aria-valuemin="1" aria-valuemax="${steps.length}" aria-valuenow="${state.wizardStep + 1}">${steps.map((_, index) => `<span class="${index <= state.wizardStep ? 'active' : ''}" aria-hidden="true"></span>`).join('')}</div>`; }
function draftStatusMarkup() { const labels = { saving: 'сохраняем…', saved: 'сохранено на устройстве', error: 'не удалось сохранить' }; return `<span id="draft-status" class="save-status ${state.draftSaveStatus === 'error' ? 'error' : ''}">${labels[state.draftSaveStatus]}</span>`; }
function newView() {
  const step = steps[state.wizardStep];
  const confidence = Number.isFinite(Number(state.draft.confidence)) ? Number(state.draft.confidence) : 50;
  let field = '';
  if (step.key === 'question' || step.key === 'context' || step.key === 'chosenPath') field = `<div class="field"><label for="draft-${step.key}">${step.label}</label><textarea id="draft-${step.key}" data-draft="${step.key}" autofocus placeholder="${esc(step.placeholder)}">${esc(state.draft[step.key])}</textarea></div>`;
  if (step.key === 'options') field = `<div class="field"><span class="field-label">${step.label}</span><div class="option-list">${state.draft.options.map((option, index) => `<div class="option-row"><input aria-label="вариант ${index + 1}" data-option-index="${index}" value="${esc(option)}" placeholder="вариант ${index + 1}"${index === 0 ? ' autofocus' : ''}>${state.draft.options.length > 2 ? `<button class="text-button remove-option" data-action="remove-option" data-index="${index}" aria-label="удалить вариант ${index + 1}">удалить</button>` : ''}</div>`).join('')}</div><button class="btn ghost" type="button" data-action="add-option">добавить вариант</button></div>`;
  if (step.key === 'confidence') field = `<div class="field"><label for="draft-confidence">${step.label}</label><input id="draft-confidence" data-draft="confidence" type="range" min="0" max="100" step="5" value="${confidence}"><div class="range-meta"><span>0</span><strong id="confidence-value">${confidence}%</strong><span>100</span></div></div>`;
  if (step.key === 'reviewDate') { const min = today(); const value = state.draft.reviewDate || min; field = `<div class="field"><label for="draft-date">${step.label}</label><input id="draft-date" data-draft="reviewDate" type="date" min="${min}" value="${esc(value)}" autofocus><div class="preset-row"><button class="btn ghost" type="button" data-action="date-preset" data-days="7">через 7 дней</button><button class="btn ghost" type="button" data-action="date-preset" data-days="30">через 30 дней</button><button class="btn ghost" type="button" data-action="date-preset" data-days="365">через год</button></div></div>`; }
  return shell(`<div class="page-heading"><button class="back" data-action="archive">← архив</button><div><div class="eyebrow">новая капсула · шаг ${state.wizardStep + 1} из ${steps.length}</div><h1>${step.title}</h1><p>${step.help}</p></div></div>${progressMarkup()}<form class="form-frame" id="capsule-form"><div class="form-meta"><span class="step-kicker mono">${String(state.wizardStep + 1).padStart(2, '0')} / ${steps.length}</span>${draftStatusMarkup()}</div>${field}<div id="form-error" class="error" role="alert"></div><div class="form-actions"><button class="btn ghost" type="button" data-action="prev"${state.wizardStep === 0 ? ' disabled' : ''}>назад</button><div class="right"><button class="btn primary" type="submit">${state.wizardStep === steps.length - 1 ? 'проверить' : 'продолжить'}</button></div></div></form>`);
}
function summaryRows(capsule) { return `<div class="summary-row"><dt>контекст</dt><dd>${text(capsule.context)}</dd></div><div class="summary-row"><dt>варианты</dt><dd>${capsule.options.map((option, index) => `${index + 1}. ${esc(option)}`).join('<br>')}</dd></div><div class="summary-row"><dt>выбранный путь</dt><dd>${text(capsule.chosenPath)}</dd></div><div class="summary-row"><dt>уверенность</dt><dd>${Number(capsule.confidence)}%</dd></div><div class="summary-row"><dt>дата пересмотра</dt><dd>${formatDate(capsule.reviewDate)}</dd></div>`; }
function reviewView() { const d = state.draft; return shell(`<div class="page-heading"><button class="back" data-action="edit-draft">← изменить</button><div><div class="eyebrow">проверка капсулы</div><h1>проверьте капсулу перед запечатыванием.</h1><p>после запечатывания исходные поля нельзя редактировать.</p></div></div><div class="envelope">${stampMarkup('капсула', 'NEW')}<div class="eyebrow">вопрос</div><h2 class="card-question">${esc(d.question)}</h2><dl class="summary">${summaryRows(d)}</dl></div><div class="form-actions"><button class="btn ghost" data-action="edit-draft">вернуться к редактированию</button><div class="right"><button class="btn primary" data-action="seal"${state.busyAction ? ' disabled' : ''}>${state.busyAction === 'seal' ? 'сохраняем…' : 'запечатать'}</button></div></div>`); }
function detailView(capsule) {
  const status = getStatus(capsule, state.today); const opened = Boolean(capsule.openedAt); const canOpen = status === 'ready' && !opened;
  return shell(`<div class="page-heading"><button class="back" data-action="archive">← архив</button><div><div class="eyebrow">капсула № ${numberFor(capsule)} · ${statusLabel(status)}</div><h1>${esc(capsule.question)}</h1><p>${reviewDescription(capsule)}</p></div></div><div class="detail-layout"><section><div class="envelope">${stampMarkup(opened ? 'открыта' : 'запечатано', numberFor(capsule), opened)}<dl class="summary">${summaryRows(capsule)}</dl></div>${canOpen ? '<button class="btn primary" data-action="open" data-id="' + esc(capsule.id) + '">открыть капсулу</button>' : ''}${!opened && !canOpen ? `<div class="notice"><strong>капсула закрыта до даты пересмотра.</strong><p>${reviewMeta(capsule)} · ${formatDate(capsule.reviewDate)}</p></div>` : ''}${opened ? resultForm(capsule) : ''}</section><aside class="detail-aside"><div><strong>запечатано</strong><span>${formatDateTime(capsule.sealedAt)}</span></div><div><strong>пересмотр</strong><span>${formatDate(capsule.reviewDate)} · ${reviewMeta(capsule)}</span></div>${capsule.openedAt ? `<div><strong>открыто</strong><span>${formatDateTime(capsule.openedAt)}</span></div>` : ''}<button class="btn ghost" data-action="share" data-id="${esc(capsule.id)}">ссылка</button><button class="btn ghost" data-action="markdown" data-id="${esc(capsule.id)}">скачать Markdown</button></aside></div>`);
}
function resultForm(capsule) { const hasResult = Boolean(capsule.result); return `<div class="result-box"><h2>фактический итог</h2><p>что произошло и что вы узнали?</p><form id="result-form"><div class="field"><label for="result">итог</label><textarea id="result" autofocus placeholder="запишите наблюдение">${esc(capsule.result || '')}</textarea></div><div id="result-error" class="error" role="alert"></div><div class="form-actions"><span class="save-status">${hasResult ? `сохранено ${formatDateTime(capsule.resultUpdatedAt)}` : 'пока не сохранён'}</span><div class="right"><button class="btn primary" type="submit"${state.busyAction === 'result' ? ' disabled' : ''}>${state.busyAction === 'result' ? 'сохраняем…' : hasResult ? 'сохранить итог' : 'добавить итог'}</button></div></div></form></div>`; }

function render() {
  state.today = localDate(new Date());
  if (state.loading) { root.innerHTML = '<main class="main"><div class="notice">открываем архив…</div></main>'; return; }
  renderBase();
  if (state.dialog) renderDialog(); else focusAfterRender();
}
function renderBase() { if (state.view === 'new') root.innerHTML = state.wizardStep >= steps.length ? reviewView() : newView(); else if (state.view === 'detail' && currentCapsule()) root.innerHTML = detailView(currentCapsule()); else root.innerHTML = archiveView(); }
function focusAfterRender() { const target = (window.matchMedia?.('(pointer: fine)').matches ? root.querySelector('[autofocus]') : null) || root.querySelector('main button'); if (target) setTimeout(() => target.focus(), 0); }
function renderDialog() {
  const dialog = state.dialog; let body = '';
  if (dialog.type === 'message') body = `${dialog.body}<div class="dialog-actions"><button class="btn primary" data-action="close-dialog">понятно</button></div>`;
  if (dialog.type === 'hash') body = `<p>ссылка содержит одну капсулу. архив изменится только после подтверждения.</p><div class="envelope compact-envelope"><div class="eyebrow">предпросмотр · № ${numberFor(dialog.capsule)}</div><h2 class="card-question">${esc(dialog.capsule.question)}</h2><p>${text(dialog.capsule.context)}</p><p class="mono">пересмотр: ${formatDate(dialog.capsule.reviewDate)}</p></div><div class="notice">hash не шифрует данные. любой обладатель ссылки сможет прочитать содержимое.</div><div class="dialog-actions"><button class="btn ghost" data-action="close-dialog">отмена</button><button class="btn primary" data-action="import-hash"${state.busyAction === 'import-hash' ? ' disabled' : ''}>${state.busyAction === 'import-hash' ? 'добавляем…' : 'добавить в архив'}</button></div>`;
  if (dialog.type === 'share') body = `<p>ссылка содержит данные капсулы в URL hash.</p><textarea class="url-copy" readonly aria-label="ссылка для копирования">${esc(dialog.url)}</textarea><p class="mono">длина: ${dialog.url.length} символов</p><div class="notice">не отправляйте ссылку, если капсула должна остаться личной.</div><div class="dialog-actions"><button class="btn ghost" data-action="close-dialog">закрыть</button><button class="btn primary" data-action="copy-url">скопировать</button></div>`;
  if (dialog.type === 'import') body = `<p>выберите JSON-архив. существующие ID будут пропущены.</p><div class="dialog-actions"><button class="btn ghost" data-action="close-dialog">отмена</button><button class="btn primary" data-action="pick-import">выбрать файл</button></div>`;
  if (dialog.type === 'import-preview') body = `<p>файл проверен. архив изменится только после подтверждения.</p><div class="import-summary"><div><strong>${dialog.fresh}</strong><span>новых ${plural(dialog.fresh, 'капсула', 'капсулы', 'капсул')}</span></div><div><strong>${dialog.duplicates}</strong><span>уже в архиве</span></div></div><div class="dialog-actions"><button class="btn ghost" data-action="close-dialog">отмена</button><button class="btn primary" data-action="confirm-import"${dialog.fresh && !state.busyAction ? '' : ' disabled'}>${state.busyAction === 'confirm-import' ? 'добавляем…' : 'добавить новые'}</button></div>`;
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
function setDraftStatus(status) { state.draftSaveStatus = status; const element = document.querySelector('#draft-status'); if (element) { element.textContent = status === 'saving' ? 'сохраняем…' : status === 'error' ? 'не удалось сохранить' : 'сохранено на устройстве'; element.classList.toggle('error', status === 'error'); } }
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
    if (action === 'archive') { state.view = 'archive'; state.selectedId = null; render(); return; }
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
    if (action === 'export') { download(new Blob([exportJson(state.capsules)], { type: 'application/json' }), `decision-capsules-${today()}.json`); notify('JSON-архив подготовлен.'); return; }
    if (action === 'import') { openDialog({ type: 'import', title: 'импорт архива' }, actionElement); return; }
    if (action === 'pick-import') { document.querySelector('#import-file')?.click(); return; }
    if (action === 'close-dialog') { closeDialog({ clearHash: state.dialog?.type === 'hash' || state.dialog?.clearHash }); return; }
    if (action === 'import-hash') { const incoming = state.dialog.capsule; const result = await state.repo.importCapsules([incoming]); await refresh(); closeDialog({ clearHash: true }); notify(result.imported ? 'капсула добавлена в архив.' : 'такая капсула уже есть в архиве.'); return; }
    if (action === 'confirm-import') { const incoming = state.pendingImport || []; const result = await state.repo.importCapsules(incoming); await refresh(); state.pendingImport = null; closeDialog(); notify(`добавлено: ${result.imported}. пропущено: ${result.skipped}.`); return; }
    if (action === 'share') { const capsule = state.capsules.find((item) => item.id === actionElement.dataset.id); const url = `${location.origin}${location.pathname}#capsule=${encodeCapsule(capsule)}`; openDialog({ type: 'share', title: 'ссылка на капсулу', url }, actionElement); return; }
    if (action === 'copy-url') { const area = root.querySelector('.url-copy'); try { await navigator.clipboard.writeText(area?.value || ''); notify('ссылка скопирована.'); } catch { area?.focus(); area?.select(); notify('ссылка выделена. нажмите Cmd/Ctrl+C.'); } return; }
    if (action === 'markdown') { const capsule = state.capsules.find((item) => item.id === actionElement.dataset.id); download(new Blob([exportMarkdown([capsule])], { type: 'text/markdown;charset=utf-8' }), `decision-capsule-${numberFor(capsule)}.md`); notify('Markdown подготовлен.'); return; }
  } catch (error) { notifyError(error); }
  finally { if (busyAction && state.busyAction === busyAction) { state.busyAction = null; render(); } }
});

root.addEventListener('input', (event) => {
  const element = event.target;
  if (element.matches('#search')) {
    if (event.isComposing) return;
    const caret = element.selectionStart ?? element.value.length;
    state.search = element.value;
    render();
    const next = document.querySelector('#search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
    return;
  }
  if (element.matches('[data-draft], [data-option-index]')) { setDraftFromForm(); if (element.matches('[data-draft="confidence"]')) { const output = document.querySelector('#confidence-value'); if (output) output.textContent = `${element.value}%`; } scheduleDraftSave(); }
});
root.addEventListener('compositionend', (event) => {
  if (!event.target.matches('#search')) return;
  state.search = event.target.value;
  render();
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
    if (event.target.id === 'result-form') { const capsule = currentCapsule(); const value = submittedResult.trim(); const saved = saveResult(capsule, value, new Date()); await state.repo.updateProgress(capsule.id, { result: saved.result, resultUpdatedAt: saved.resultUpdatedAt }); await refresh(); notify('итог сохранён.'); }
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
window.addEventListener('hashchange', () => { if (!location.hash) { if (state.dialog?.type === 'hash' || state.dialog?.clearHash) closeDialog(); return; } try { openDialog({ type: 'hash', capsule: decodeCapsule(location.hash), title: 'импорт по ссылке' }); } catch { openDialog({ type: 'message', title: 'ссылка не распознана', body: '<p class="error">в ссылке нет корректной капсулы.</p>', clearHash: true }); } });
setInterval(() => { const next = localDate(new Date()); if (next !== state.today) { state.today = next; if (state.view !== 'new') render(); } }, 60_000);

init();
