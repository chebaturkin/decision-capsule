/**
 * Pure domain model for Decision Capsule.
 *
 * The module deliberately has no browser or storage dependencies. It can be
 * used by the static UI, IndexedDB repository, and Node tests alike.
 */

export const EXPORT_FORMAT = 'decision-capsule';
export const EXPORT_VERSION = 1;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(message, code = 'INVALID_CAPSULE') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function cloneCapsule(capsule) {
  return { ...capsule, options: Array.isArray(capsule.options) ? [...capsule.options] : capsule.options };
}

function asTimestamp(value, field = 'date') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail(`Invalid ${field}.`, 'INVALID_DATE');
  return date;
}

function isoTimestamp(value, field = 'date') {
  if (value instanceof Date) return asTimestamp(value, field).toISOString();
  if (!isCanonicalTimestamp(value)) fail(`Invalid ${field}; expected a canonical ISO timestamp.`, 'INVALID_DATE');
  return value;
}

function isCanonicalTimestamp(value) {
  return typeof value === 'string'
    && ISO_TIMESTAMP.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year
    && utc.getUTCMonth() === month - 1
    && utc.getUTCDate() === day;
}

function assertDateOnly(value, field = 'date') {
  if (!isValidDateOnly(value)) {
    fail(`Invalid ${field}; expected YYYY-MM-DD.`, 'INVALID_DATE');
  }
}

function nonEmptyString(value, field, { trim = true } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`The ${field} field is required.`, 'INVALID_CAPSULE');
  }
  return trim ? value.trim() : value;
}

function randomId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `capsule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function nowDate(value) {
  const source = value ?? new Date();
  if (!(source instanceof Date) && !isCanonicalTimestamp(source)) {
    fail('Invalid timestamp; expected a canonical ISO timestamp.', 'INVALID_DATE');
  }
  return asTimestamp(source, 'timestamp');
}

/** Return the local device calendar date in YYYY-MM-DD form. */
export function localDate(value = new Date()) {
  if (typeof value === 'string' && DATE_ONLY.test(value)) {
    assertDateOnly(value, 'date');
    return value;
  }
  const date = asTimestamp(value, 'date');
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Derive a display status from the local calendar date. The sealed record is
 * unchanged when it becomes ready; only opening adds progress fields.
 */
export function getStatus(capsule, today = localDate()) {
  if (!capsule || typeof capsule !== 'object') fail('The capsule has an invalid format.', 'INVALID_CAPSULE');
  const localToday = today instanceof Date ? localDate(today) : today;
  assertDateOnly(localToday, 'today');
  if (capsule.openedAt) return 'opened';
  return capsule.reviewDate <= localToday ? 'ready' : 'sealed';
}

/** Return counts for the same status vocabulary used by the archive UI. */
export function statusCounts(capsules = [], today = localDate()) {
  if (!Array.isArray(capsules)) fail('Expected an array of capsules.', 'INVALID_CAPSULE');
  const counts = { all: capsules.length, sealed: 0, ready: 0, opened: 0 };
  capsules.forEach((capsule) => { counts[getStatus(capsule, today)] += 1; });
  return counts;
}

/** Number of local calendar days until review (negative after the date). */
export function daysUntilReview(capsuleOrDate, today = localDate()) {
  const reviewDate = typeof capsuleOrDate === 'string' ? capsuleOrDate : capsuleOrDate?.reviewDate;
  assertDateOnly(reviewDate, 'reviewDate');
  const localToday = today instanceof Date ? localDate(today) : today;
  assertDateOnly(localToday, 'today');
  const [reviewYear, reviewMonth, reviewDay] = reviewDate.split('-').map(Number);
  const [todayYear, todayMonth, todayDay] = localToday.split('-').map(Number);
  const reviewUtc = Date.UTC(reviewYear, reviewMonth - 1, reviewDay);
  const todayUtc = Date.UTC(todayYear, todayMonth - 1, todayDay);
  return Math.round((reviewUtc - todayUtc) / 86400000);
}

/** Describe the review timing using the same local calendar rules as status. */
export function reviewState(capsule, today = localDate()) {
  if (!capsule || typeof capsule !== 'object') fail('The capsule has an invalid format.', 'INVALID_CAPSULE');
  if (capsule.openedAt) return { key: 'opened', days: null };
  const days = daysUntilReview(capsule, today);
  if (days < 0) return { key: 'overdue', days };
  if (days === 0) return { key: 'due', days };
  return { key: 'upcoming', days };
}

/** Normalize draft values without turning an intentional confidence of zero into a fallback. */
export function normalizeDraft(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const confidenceValue = typeof source.confidence === 'string' && source.confidence.trim() !== ''
    ? Number(source.confidence)
    : source.confidence;
  const confidence = Number.isInteger(confidenceValue) && confidenceValue >= 0 && confidenceValue <= 100
    ? confidenceValue
    : 50;
  const options = Array.isArray(source.options)
    ? source.options.map((option) => typeof option === 'string' ? option.trim() : String(option ?? ''))
    : ['', ''];
  while (options.length < 2) options.push('');
  return {
    question: typeof source.question === 'string' ? source.question.trim() : String(source.question ?? ''),
    context: typeof source.context === 'string' ? source.context.trim() : String(source.context ?? ''),
    options,
    chosenPath: typeof source.chosenPath === 'string' ? source.chosenPath.trim() : String(source.chosenPath ?? ''),
    confidence,
    reviewDate: typeof source.reviewDate === 'string' ? source.reviewDate.trim() : String(source.reviewDate ?? ''),
  };
}

/**
 * Validate a complete stored capsule. This is intentionally a boolean API so
 * callers can use it for previews; mutating functions provide detailed errors.
 */
export function validateCapsule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.id !== 'string' || !value.id.trim()) return false;
  if (!Number.isInteger(value.number) || value.number < 1) return false;
  if (typeof value.question !== 'string' || !value.question.trim()) return false;
  if (typeof value.context !== 'string') return false;
  if (!Array.isArray(value.options) || value.options.length < 2) return false;
  if (value.options.some((option) => typeof option !== 'string' || !option.trim())) return false;
  if (typeof value.chosenPath !== 'string' || !value.chosenPath.trim()) return false;
  if (typeof value.confidence !== 'number' || !Number.isInteger(value.confidence) || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 100) return false;
  if (!isValidDateOnly(value.reviewDate)) return false;
  if (!isCanonicalTimestamp(value.createdAt) || !isCanonicalTimestamp(value.sealedAt)) return false;
  if (Date.parse(value.sealedAt) < Date.parse(value.createdAt)) return false;
  if (value.openedAt !== null && !isCanonicalTimestamp(value.openedAt)) return false;
  if (value.openedAt !== null) {
    if (Date.parse(value.openedAt) < Date.parse(value.sealedAt)) return false;
    if (localDate(value.openedAt) < value.reviewDate) return false;
  }
  if (value.result === null) {
    if (value.resultUpdatedAt !== null) return false;
  } else {
    if (typeof value.result !== 'string' || !value.result.trim() || value.openedAt === null) return false;
    if (!isCanonicalTimestamp(value.resultUpdatedAt)) return false;
    if (Date.parse(value.resultUpdatedAt) < Date.parse(value.openedAt)) return false;
  }
  return true;
}

function assertValidCapsule(value) {
  if (!validateCapsule(value)) {
    fail('The capsule has an invalid format.', 'INVALID_CAPSULE');
  }
  return value;
}

/** Create and seal a capsule. Original fields are thereafter treated as immutable. */
export function createCapsule(input = {}, sealedAt = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('The capsule input has an invalid format.', 'INVALID_CAPSULE');
  }
  const timestamp = nowDate(sealedAt);
  const options = Array.isArray(input.options)
    ? input.options.map((option) => nonEmptyString(option, 'option'))
    : fail('The options field must contain at least two options.', 'INVALID_CAPSULE');
  if (options.length < 2) fail('The options field must contain at least two options.', 'INVALID_CAPSULE');
  const confidence = typeof input.confidence === 'string' && input.confidence.trim() !== ''
    ? Number(input.confidence)
    : input.confidence;
  const number = typeof input.number === 'string' && input.number.trim() !== ''
    ? Number(input.number)
    : input.number;
  const capsule = {
    id: input.id === undefined ? randomId() : nonEmptyString(input.id, 'id'),
    number: input.number === undefined ? 1 : number,
    question: nonEmptyString(input.question, 'question'),
    context: typeof input.context === 'string' ? input.context.trim() : '',
    options,
    chosenPath: nonEmptyString(input.chosenPath, 'chosenPath'),
    confidence,
    reviewDate: input.reviewDate,
    createdAt: input.createdAt === undefined ? timestamp.toISOString() : isoTimestamp(input.createdAt, 'createdAt'),
    sealedAt: input.sealedAt === undefined ? timestamp.toISOString() : isoTimestamp(input.sealedAt, 'sealedAt'),
    openedAt: null,
    result: null,
    resultUpdatedAt: null,
  };
  if (!Number.isInteger(confidence) || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    fail('The confidence field must be an integer from 0 to 100.', 'INVALID_CAPSULE');
  }
  assertValidCapsule(capsule);
  return capsule;
}

/** Open a due capsule, returning a new record and preserving the input object. */
export function openCapsule(capsule, openedAt = new Date()) {
  assertValidCapsule(capsule);
  const timestamp = nowDate(openedAt);
  if (capsule.openedAt) return cloneCapsule(capsule);
  if (capsule.reviewDate > localDate(timestamp)) {
    fail('The capsule cannot be opened before its review date.', 'TOO_EARLY');
  }
  const next = { ...cloneCapsule(capsule), openedAt: timestamp.toISOString() };
  assertValidCapsule(next);
  return next;
}

/** Save or replace the factual result for an opened capsule. */
export function saveResult(capsule, result, updatedAt = new Date()) {
  assertValidCapsule(capsule);
  if (!capsule.openedAt) fail('The capsule must be opened before saving a result.', 'NOT_OPENED');
  const text = nonEmptyString(result, 'result');
  const timestamp = nowDate(updatedAt);
  if (timestamp.getTime() < Date.parse(capsule.openedAt)) {
    fail('The result timestamp cannot be earlier than the opening.', 'INVALID_DATE');
  }
  if (capsule.resultUpdatedAt && timestamp.getTime() < Date.parse(capsule.resultUpdatedAt)) {
    fail('The result timestamp cannot move backwards.', 'INVALID_DATE');
  }
  const next = { ...cloneCapsule(capsule), result: text, resultUpdatedAt: timestamp.toISOString() };
  assertValidCapsule(next);
  return next;
}

function asCapsuleArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.capsules)) return value.capsules;
  fail('Expected an array of capsules.', 'INVALID_EXPORT');
}

function assertCapsuleArray(value) {
  const capsules = asCapsuleArray(value);
  capsules.forEach((capsule, index) => {
    if (!validateCapsule(capsule)) fail(`Capsule at index ${index} has an invalid format.`, 'INVALID_CAPSULE');
  });
  return capsules;
}

/** Serialize an archive as a versioned JSON transfer file. */
export function exportJson(capsules) {
  const values = assertCapsuleArray(capsules);
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    capsules: values,
  }, null, 2);
}

/** Parse and validate a versioned JSON transfer file before any storage write. */
export function parseImport(source) {
  let payload;
  if (typeof source === 'string') {
    try {
      payload = JSON.parse(source);
    } catch {
      fail('The import file is not valid JSON.', 'INVALID_EXPORT');
    }
  } else {
    payload = source;
  }
  if (Array.isArray(payload)) return assertCapsuleArray(payload).map(cloneCapsule);
  if (!payload || typeof payload !== 'object' || payload.format !== EXPORT_FORMAT || payload.version !== EXPORT_VERSION) {
    fail('The import file has an unsupported format or version.', 'INVALID_EXPORT');
  }
  return assertCapsuleArray(payload.capsules).map(cloneCapsule);
}

function markdownValue(value) {
  return String(value ?? '').replaceAll('\r\n', '\n');
}

/** Serialize an archive as a readable Markdown document. */
export function exportMarkdown(capsules) {
  const values = assertCapsuleArray(capsules);
  const statusLabels = { sealed: 'запечатана', ready: 'готова к открытию', opened: 'открыта' };
  const lines = ['# архив решений', ''];
  values.forEach((capsule, index) => {
    lines.push(`## ${capsule.number ?? index + 1}. ${markdownValue(capsule.question)}`);
    lines.push('');
    lines.push(`- статус: ${statusLabels[getStatus(capsule)] || getStatus(capsule)}`);
    lines.push(`- дата пересмотра: ${capsule.reviewDate}`);
    lines.push(`- уверенность: ${capsule.confidence}%`);
    lines.push('');
    lines.push('### контекст');
    lines.push(markdownValue(capsule.context) || 'не указан');
    lines.push('');
    lines.push('### варианты');
    capsule.options.forEach((option) => lines.push(`- ${markdownValue(option)}`));
    lines.push('');
    lines.push(`### выбранный путь\n${markdownValue(capsule.chosenPath)}`);
    if (capsule.openedAt) lines.push(`\nоткрыта: ${capsule.openedAt}`);
    if (capsule.result !== null) lines.push(`\n### итог\n${markdownValue(capsule.result)}\nитог обновлён: ${capsule.resultUpdatedAt}`);
    lines.push('');
  });
  return `${lines.join('\n').trimEnd()}\n`;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Encode one capsule as URL-safe base64. This is transport encoding, not encryption. */
export function encodeCapsule(capsule) {
  assertValidCapsule(capsule);
  const bytes = new TextEncoder().encode(JSON.stringify(capsule));
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Decode and validate a URL-safe base64 capsule payload. */
export function decodeCapsule(token) {
  if (typeof token !== 'string' || !token.trim()) fail('Invalid hash data: the capsule link is empty.', 'INVALID_HASH');
  let compact = token.trim();
  // Accept the token itself as well as a hash fragment passed by a router.
  if (compact.startsWith('#')) compact = compact.slice(1);
  if (compact.startsWith('capsule=')) compact = compact.slice('capsule='.length);
  if (!/^[A-Za-z0-9_-]+$/.test(compact) || compact.length % 4 === 1) {
    fail('Invalid hash data: the capsule link is malformed.', 'INVALID_HASH');
  }
  const base64 = compact.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (compact.length % 4)) % 4);
  try {
    const bytes = base64ToBytes(base64);
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    assertValidCapsule(payload);
    return cloneCapsule(payload);
  } catch (error) {
    if (error?.code === 'INVALID_CAPSULE') throw error;
    fail('Invalid hash data: the capsule link is malformed.', 'INVALID_HASH');
  }
}
