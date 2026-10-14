// Only owned interface strings are translated. Project data is always kept verbatim.
const i18n = globalThis.I18n;
const t = (key, values) => i18n.t(key, values);
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
function formatDate(value) { if (!value) return t("m140"); return new Intl.DateTimeFormat(i18n.locale === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium' }).format(new Date(`${value}T12:00:00`)); }
function formatDateTime(value) { if (!value) return t("m140"); return new Intl.DateTimeFormat(i18n.locale === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function numberFor(c) { return String(c.number ?? 0).padStart(3, '0'); }
function statusLabel(status) { return ({ sealed: t("m139"), ready: t("m138"), opened: t("m137") })[status] ?? status; }
function statusClass(status) { return status === 'sealed' ? 'sealed' : status === 'opened' ? 'opened' : 'ready'; }
function currentCapsule() { return state.capsules.find((capsule) => capsule.id === state.selectedId); }
function plural(n, one, few, many) { if (i18n.locale === 'en') return n === 1 ? one : many; const x = n % 10; const y = n % 100; return x === 1 && y !== 11 ? one : x >= 2 && x <= 4 && (y < 10 || y >= 20) ? few : many; }
function reviewMeta(capsule) {
  const timing = reviewState(capsule, state.today);
  if (timing.key === 'opened') return t("m137");
  if (timing.key === 'due') return t("m136");
  if (timing.key === 'overdue') return t("m135", [Math.abs(timing.days), plural(Math.abs(timing.days), t("m134"), t("m133"), t("m132"))]);
  return t("m131", [timing.days, plural(timing.days, t("m134"), t("m133"), t("m132"))]);
}
function friendlyError(error) {
  const map = {
    TOO_EARLY: t("m130"),
    NOT_OPENED: t("m129"),
    INVALID_HASH: t("m128"),
    INVALID_EXPORT: t("m127"),
    INVALID_CAPSULE: t("m126"),
  };
  if (map[error?.code]) return map[error.code];
  if (i18n.locale === 'ru' && typeof error?.message === 'string' && /[А-Яа-яЁё]/.test(error.message)) return error.message;
  return t("m125");
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
function toastMarkup() { return state.toast ? t("m124", [esc(state.toast)]) : ''; }
function notifyError(error) { const message = friendlyError(error); announce(t("m123", [message])); state.dialog = { type: 'message', title: t("m122"), body: `<p class="error">${esc(message)}</p>` }; render(); }

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
      try { state.dialog = { type: 'hash', capsule: decodeCapsule(hashPayload), title: t("m003") }; }
      catch { state.dialog = { type: 'message', title: t("m002"), body: t("m121"), clearHash: true }; }
    }
    render();
  } catch (error) {
    state.loading = false;
    root.innerHTML = t("m119", [esc(i18n.locale === 'en' ? t("m120") : error.message || t("m120"))]);
  }
}

function shell(content) {
  return t("m116", [state.view !== 'new' ? t("m118") : t("m117"), content, toastMarkup(), i18n.control()]);
}

function archiveView() {
  const now = today();
  const counts = summarizeArchive(state.capsules, now);
  const filtered = filterAndSortCapsules(state.capsules, { today: now, filter: state.filter, search: state.search, sort: state.sort });
  const groups = state.filter === 'all'
    ? [['ready', t("m115")], ['sealed', t("m113")], ['opened', t("m111")]].map(([key, label]) => [key, label, filtered.filter((capsule) => getStatus(capsule, now) === key)]).filter(([, , items]) => items.length)
    : [[state.filter, '', filtered]];
  const emptyArchive = !state.capsules.length;
  const filterLabels = { all: t("m114"), sealed: t("m113"), ready: t("m112"), opened: t("m111") };
  return shell(t("m094", [draftHasContent() ? t("m095", [Math.min(state.wizardStep + 1, steps.length), steps.length]) : '', state.capsules.corrupted?.length ? t("m096", [state.capsules.corrupted.length, plural(state.capsules.corrupted.length, t("m099"), t("m098"), t("m097"))]) : '', !emptyArchive ? t("m100", [['all', 'sealed', 'ready', 'opened'].map((key) => `<button data-action="filter" data-filter="${key}" aria-pressed="${state.filter === key}">${filterLabels[key]}<span class="filter-count">${counts[key]}</span></button>`).join(''), esc(state.search), state.search ? t("m101") : '', state.sort === 'review-asc' ? ' selected' : '', state.sort === 'review-desc' ? ' selected' : '', state.sort === 'created-desc' ? ' selected' : '', state.sort === 'created-asc' ? ' selected' : '']) : '', emptyArchive ? t("m110") : !filtered.length ? `<section class="empty"><h2>${state.search.trim() ? t("m109") : t("m108")}</h2><p>${state.search.trim() ? t("m107", [esc(state.search.trim())]) : state.filter === 'ready' ? t("m106") : state.filter === 'opened' ? t("m105") : t("m104")}</p><button class="btn ghost" data-action="${state.search.trim() ? 'clear-search' : 'filter'}"${state.search.trim() ? '' : ' data-filter="all"'}>${state.search.trim() ? t("m103") : t("m102")}</button></section>` : groups.map(([, label, items]) => archiveSection(label, items)).join('')]));
}
function archiveSection(label, items) {
  return `<section class="archive-section"${label ? '' : t("m093")}>${label ? `<div class="section-heading"><h2>${label}</h2></div>` : ''}<div class="capsule-grid">${items.map(card).join('')}</div></section>`;
}
function card(capsule) {
  const status = getStatus(capsule, state.today);
  const excerptSource = capsule.context || capsule.chosenPath || '';
  const excerpt = excerptSource.length > 130 ? `${excerptSource.slice(0, 130).trimEnd()}…` : excerptSource;
  return t("m092", [esc(capsule.question), excerpt ? `<p class="card-excerpt">${esc(excerpt)}</p>` : '', statusClass(status), statusLabel(status), numberFor(capsule), esc(capsule.reviewDate), formatDate(capsule.reviewDate), reviewState(capsule, state.today).key, reviewMeta(capsule), esc(capsule.id), esc(capsule.question)]);
}

const steps = i18n.live(() => ([
  { key: 'question', title: t("m091"), help: t("m090"), label: t("m089"), placeholder: t("m088") },
  { key: 'context', title: t("m087"), help: t("m086"), label: t("m085"), placeholder: t("m084") },
  { key: 'options', title: t("m083"), help: t("m082"), label: t("m081") },
  { key: 'chosenPath', title: t("m080"), help: t("m079"), label: t("m078"), placeholder: t("m077") },
  { key: 'confidence', title: t("m076"), help: t("m075"), label: t("m074") },
  { key: 'reviewDate', title: t("m073"), help: t("m072"), label: t("m071") },
]));
function progressMarkup() { return t("m070", [steps.length, state.wizardStep + 1, steps.map((_, index) => `<span class="${index <= state.wizardStep ? 'active' : ''}" aria-hidden="true"></span>`).join('')]); }
function draftStatusMarkup() { const labels = { saving: t("m030"), saved: t("m028"), error: t("m029") }; return `<span id="draft-status" class="save-status ${state.draftSaveStatus === 'error' ? 'error' : ''}">${labels[state.draftSaveStatus]}</span>`; }
function newView() {
  const step = steps[state.wizardStep];
  const confidence = Number.isFinite(Number(state.draft.confidence)) ? Number(state.draft.confidence) : 50;
  let field = '';
  if (step.key === 'question' || step.key === 'context' || step.key === 'chosenPath') field = `<div class="field"><label for="draft-${step.key}">${step.label}</label><textarea id="draft-${step.key}" data-draft="${step.key}" autofocus placeholder="${esc(step.placeholder)}">${esc(state.draft[step.key])}</textarea></div>`;
  if (step.key === 'options') field = t("m067", [step.label, state.draft.options.map((option, index) => t("m068", [index + 1, index, esc(option), index + 1, index === 0 ? ' autofocus' : '', state.draft.options.length > 2 ? t("m069", [index, index + 1]) : ''])).join('')]);
  if (step.key === 'confidence') field = `<div class="field"><label for="draft-confidence">${step.label}</label><input id="draft-confidence" data-draft="confidence" type="range" min="0" max="100" step="5" value="${confidence}"><div class="range-meta"><span>0</span><strong id="confidence-value">${confidence}%</strong><span>100</span></div></div>`;
  if (step.key === 'reviewDate') { const min = today(); const value = state.draft.reviewDate || min; field = t("m066", [step.label, min, esc(value)]); }
  return shell(t("m063", [step.title, step.help, state.wizardStep + 1, steps.length, draftStatusMarkup(), progressMarkup(), field, state.wizardStep === 0 ? ' disabled' : '', state.wizardStep === steps.length - 1 ? t("m065") : t("m064")]));
}
function summaryRows(capsule) { return t("m062", [text(capsule.context), capsule.options.map((option) => `<li>${esc(option)}</li>`).join(''), text(capsule.chosenPath), Number(capsule.confidence), formatDate(capsule.reviewDate)]); }
function reviewView() { const d = state.draft; return shell(t("m060", [esc(d.question), summaryRows(d), state.busyAction ? ' disabled' : '', state.busyAction === 'seal' ? t("m030") : t("m061")])); }
function detailView(capsule) {
  const status = getStatus(capsule, state.today); const opened = Boolean(capsule.openedAt); const canOpen = status === 'ready' && !opened;
  return shell(t("m055", [esc(capsule.question), statusClass(status), statusLabel(status), numberFor(capsule), summaryRows(capsule), canOpen ? t("m057") + esc(capsule.id) + t("m056") : '', !opened && !canOpen ? t("m058", [formatDate(capsule.reviewDate)]) : '', opened ? resultForm(capsule) : '', formatDateTime(capsule.sealedAt), formatDate(capsule.reviewDate), capsule.openedAt ? t("m059", [formatDateTime(capsule.openedAt)]) : '', esc(capsule.id), esc(capsule.id)]));
}
function resultStatus(capsule) {
  if (state.resultDrafts.has(capsule.id) && state.resultDrafts.get(capsule.id) !== (capsule.result || '')) return t("m054");
  return capsule.result ? t("m053", [formatDateTime(capsule.resultUpdatedAt)]) : t("m052");
}
function resultForm(capsule) {
  const hasResult = Boolean(capsule.result);
  const value = state.resultDrafts.get(capsule.id) ?? capsule.result ?? '';
  return t("m049", [esc(value), resultStatus(capsule), state.busyAction === 'result' ? ' disabled' : '', state.busyAction === 'result' ? t("m030") : hasResult ? t("m051") : t("m050")]);
}

function render({ focus = true } = {}) {
  clearTimeout(focusTimer);
  state.today = localDate(new Date());
  if (state.loading) { root.innerHTML = t("m048"); return; }
  const page = `${state.view}:${state.selectedId || ''}:${state.view === 'new' ? state.wizardStep : ''}`;
  const changedPage = page !== renderedPage;
  renderBase();
  i18n.updateControls();
  renderedPage = page;
  if (changedPage) window.scrollTo(0, 0);
  if (state.dialog) renderDialog(); else if (focus) focusAfterRender(changedPage);
}
function renderBase() { if (state.view === 'new') root.innerHTML = state.wizardStep >= steps.length ? reviewView() : newView(); else if (state.view === 'detail' && currentCapsule()) root.innerHTML = detailView(currentCapsule()); else root.innerHTML = archiveView(); }
function focusAfterRender(changedPage) { const target = (changedPage && state.view === 'detail' ? null : window.matchMedia?.('(pointer: fine)').matches ? root.querySelector('[autofocus]') : null) || root.querySelector('main h1'); if (target) { if (target.matches('h1')) target.tabIndex = -1; focusTimer = setTimeout(() => target.focus({ preventScroll: true }), 0); } }
function renderDialog() {
  const dialog = state.dialog; let body = '';
  if (dialog.type === 'message') body = t("m047", [i18n.owned(dialog.body)]);
  if (dialog.type === 'hash') body = t("m045", [esc(dialog.capsule.question), text(dialog.capsule.context), formatDate(dialog.capsule.reviewDate), state.busyAction === 'import-hash' ? ' disabled' : '', state.busyAction === 'import-hash' ? t("m042") : t("m046")]);
  if (dialog.type === 'share') body = t("m044", [esc(dialog.url)]);
  if (dialog.type === 'import') body = t("m043", []);
  if (dialog.type === 'import-preview') body = t("m037", [dialog.fresh, plural(dialog.fresh, t("m040"), t("m039"), t("m038")), dialog.duplicates, dialog.fresh && !state.busyAction ? '' : ' disabled', state.busyAction === 'confirm-import' ? t("m042") : t("m041")]);
  if (dialog.type === 'draft-choice') body = t("m036", []);
  if (dialog.type === 'clear-draft') body = t("m035", []);
  if (dialog.type === 'open-confirm') body = t("m032", [esc(dialog.capsule.id), state.busyAction === 'confirm-open' ? ' disabled' : '', state.busyAction === 'confirm-open' ? t("m034") : t("m033")]);
  root.insertAdjacentHTML('beforeend', `<div class="dialog-backdrop" data-action="backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description"><h2 id="dialog-title">${esc(i18n.owned(dialog.title) || t("m031"))}</h2><div id="dialog-description">${body}</div></section></div>`);
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
function setDraftStatus(status) { state.draftSaveStatus = status; const element = document.querySelector('#draft-status'); if (element) { element.textContent = status === 'saving' ? t("m030") : status === 'error' ? t("m029") : t("m028"); element.classList.toggle('error', status === 'error'); } }
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
  if (key === 'question' && !d.question.trim()) return t("m027");
  if (key === 'context' && !d.context.trim()) return t("m026");
  if (key === 'options') {
    d.options = d.options.map((value) => value.trim()).filter(Boolean);
    while (d.options.length < 2) d.options.push('');
    if (d.options.filter(Boolean).length < 2) return t("m025");
  }
  if (key === 'chosenPath' && !d.chosenPath.trim()) return t("m024");
  if (key === 'reviewDate' && (!d.reviewDate || d.reviewDate < today() || Number.isNaN(new Date(`${d.reviewDate}T12:00:00`).getTime()))) return t("m023");
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
    if (action === 'new') { if (draftHasContent()) { openDialog({ type: 'draft-choice', title: t("m022") }, actionElement); } else { state.view = 'new'; state.draft = blankDraft(); state.wizardStep = 0; render(); } return; }
    if (action === 'resume-draft') { state.dialog = null; state.dialogTrigger = null; state.view = 'new'; render(); return; }
    if (action === 'start-new') { await clearDraftAndReset(); state.dialog = null; state.dialogTrigger = null; state.view = 'new'; render(); return; }
    if (action === 'clear-draft') { openDialog({ type: 'clear-draft', title: t("m021") }, actionElement); return; }
    if (action === 'confirm-clear-draft') { await clearDraftAndReset(); closeDialog(); notify(t("m020")); return; }
    if (action === 'archive') { if (state.view === 'new') { setDraftFromForm(); await flushDraftSave(); } state.view = 'archive'; state.selectedId = null; render(); return; }
    if (action === 'filter') { state.filter = actionElement.dataset.filter; state.view = 'archive'; render(); return; }
    if (action === 'detail') { state.selectedId = actionElement.dataset.id; state.view = 'detail'; render(); return; }
    if (action === 'prev') { setDraftFromForm(); state.wizardStep = Math.max(0, state.wizardStep - 1); await flushDraftSave(); render(); return; }
    if (action === 'edit-draft') { state.wizardStep = steps.length - 1; state.view = 'new'; await flushDraftSave(); render(); return; }
    if (action === 'clear-search') { state.search = ''; render(); return; }
    if (action === 'add-option') { setDraftFromForm(); state.draft.options.push(''); scheduleDraftSave(); render(); return; }
    if (action === 'remove-option') { setDraftFromForm(); if (state.draft.options.length > 2) state.draft.options.splice(Number(actionElement.dataset.index), 1); scheduleDraftSave(); render(); return; }
    if (action === 'date-preset') { state.draft.reviewDate = addDays(today(), actionElement.dataset.days); scheduleDraftSave(); render(); return; }
    if (action === 'seal') { await flushDraftSave(); const capsule = await sealDraft(); await refresh(); state.draft = blankDraft(); state.wizardStep = 0; state.selectedId = capsule.id; state.view = 'detail'; notify(t("m019")); return; }
    if (action === 'open') { const capsule = currentCapsule(); if (!capsule) { state.view = 'archive'; render(); return; } openDialog({ type: 'open-confirm', title: t("m018"), capsule }, actionElement); return; }
    if (action === 'confirm-open') { const capsule = currentCapsule(); const opened = openCapsule(capsule, new Date()); await state.repo.updateProgress(capsule.id, { openedAt: opened.openedAt }); await refresh(); closeDialog(); notify(t("m017")); return; }
    if (action === 'export') { download(new Blob([exportJson(state.capsules)], { type: 'application/json' }), `decision-capsules-${today()}.json`); notify(t("m016")); return; }
    if (action === 'import') { openDialog({ type: 'import', title: t("m015") }, actionElement); return; }
    if (action === 'pick-import') { document.querySelector('#import-file')?.click(); return; }
    if (action === 'close-dialog') { closeDialog({ clearHash: state.dialog?.type === 'hash' || state.dialog?.clearHash }); return; }
    if (action === 'import-hash') { const incoming = state.dialog.capsule; const result = await state.repo.importCapsules([incoming]); await refresh(); closeDialog({ clearHash: true }); notify(result.imported ? t("m014") : t("m013")); return; }
    if (action === 'confirm-import') { const incoming = state.pendingImport || []; const result = await state.repo.importCapsules(incoming); await refresh(); state.pendingImport = null; closeDialog(); notify(t("m012", [result.imported, result.skipped])); return; }
    if (action === 'share') { const capsule = state.capsules.find((item) => item.id === actionElement.dataset.id); const url = `${location.origin}${location.pathname}#capsule=${encodeCapsule(capsule)}`; openDialog({ type: 'share', title: t("m011"), url }, actionElement); return; }
    if (action === 'copy-url') { const area = root.querySelector('.url-copy'); try { await navigator.clipboard.writeText(area?.value || ''); notify(t("m010")); } catch { area?.focus(); area?.select(); notify(t("m009")); } return; }
    if (action === 'markdown') { const capsule = state.capsules.find((item) => item.id === actionElement.dataset.id); download(new Blob([exportMarkdown([capsule], i18n.locale)], { type: 'text/markdown;charset=utf-8' }), `decision-capsule-${numberFor(capsule)}.md`); notify(t("m008")); return; }
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
    if (box) box.textContent = t("m007");
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
    if (event.target.id === 'result-form') { const capsule = currentCapsule(); const value = submittedResult.trim(); const saved = saveResult(capsule, value, new Date()); await state.repo.updateProgress(capsule.id, { result: saved.result, resultUpdatedAt: saved.resultUpdatedAt }); await refresh(); if (state.resultDrafts.get(capsule.id) === submittedResult) state.resultDrafts.delete(capsule.id); notify(t("m006")); }
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
    state.dialog = { type: 'import-preview', title: t("m005"), fresh: parsed.length - duplicates, duplicates };
    render();
  }
  catch (error) { state.dialog = { type: 'message', title: t("m004"), body: `<p class="error">${esc(friendlyError(error))}</p>` }; render(); }
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
window.addEventListener('hashchange', () => { if (!location.hash) { if (state.dialog?.type === 'hash' || state.dialog?.clearHash) closeDialog(); return; } if (!location.hash.startsWith('#capsule=')) return; try { openDialog({ type: 'hash', capsule: decodeCapsule(location.hash), title: t("m003") }); } catch { openDialog({ type: 'message', title: t("m002"), body: t("m001"), clearHash: true }); } });
setInterval(() => { const next = localDate(new Date()); if (next !== state.today) { state.today = next; if (state.view !== 'new') render(); } }, 60_000);

init();

i18n.subscribe(() => { setDraftFromForm(); clearToast(); render({ focus: false }); i18n.updateControls(); });
