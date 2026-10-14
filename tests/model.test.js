import test from 'node:test';
import assert from 'node:assert/strict';

import {
  localDate,
  getStatus,
  createCapsule,
  openCapsule,
  saveResult,
  validateCapsule,
  exportJson,
  parseImport,
  exportMarkdown,
  encodeCapsule,
  decodeCapsule,
  normalizeDraft,
  statusCounts,
  daysUntilReview,
  reviewState,
} from '../lib/model.js';

const NOW = new Date('2026-10-08T12:34:56.000Z');

function draft(overrides = {}) {
  return {
    id: 'capsule-1',
    number: 7,
    question: 'Стоит ли менять направление?',
    context: 'Есть два пути и ограниченное время.',
    options: ['Сохранить текущий путь', 'Попробовать новый'],
    chosenPath: 'Попробовать новый',
    confidence: 72,
    reviewDate: '2026-11-01',
    ...overrides,
  };
}

test('localDate uses the device calendar components', () => {
  const date = new Date(2026, 9, 8, 23, 59, 0);
  assert.equal(localDate(date), '2026-10-08');
});

test('createCapsule seals a normalized immutable record', () => {
  const capsule = createCapsule({
    ...draft(),
    question: '  Стоит ли менять направление?  ',
    options: [' Сохранить текущий путь ', 'Попробовать новый'],
    confidence: '72',
  }, NOW);

  assert.deepEqual(capsule, {
    id: 'capsule-1',
    number: 7,
    question: 'Стоит ли менять направление?',
    context: 'Есть два пути и ограниченное время.',
    options: ['Сохранить текущий путь', 'Попробовать новый'],
    chosenPath: 'Попробовать новый',
    confidence: 72,
    reviewDate: '2026-11-01',
    createdAt: NOW.toISOString(),
    sealedAt: NOW.toISOString(),
    openedAt: null,
    result: null,
    resultUpdatedAt: null,
  });
  assert.equal(validateCapsule(capsule), true);
});

test('getStatus derives sealed, ready, and opened states from local date', () => {
  const sealed = createCapsule(draft({ reviewDate: '2026-10-09' }), NOW);
  const ready = createCapsule(draft({ reviewDate: '2026-10-08' }), NOW);
  const overdue = createCapsule(draft({ reviewDate: '2026-10-01' }), NOW);
  const opened = { ...ready, openedAt: '2026-10-08T12:00:00.000Z' };

  assert.equal(getStatus(sealed, '2026-10-08'), 'sealed');
  assert.equal(getStatus(ready, '2026-10-08'), 'ready');
  assert.equal(getStatus(overdue, '2026-10-08'), 'ready');
  assert.equal(getStatus(opened, '2026-10-08'), 'opened');
});

test('openCapsule rejects early opening without mutating the original', () => {
  const capsule = createCapsule(draft({ reviewDate: '2026-10-09' }), NOW);

  assert.throws(
    () => openCapsule(capsule, new Date('2026-10-08T08:00:00.000Z')),
    /review date|дата/i,
  );
  assert.equal(capsule.openedAt, null);
});

test('openCapsule records opening on or after the review date', () => {
  const capsule = createCapsule(draft({ reviewDate: '2026-10-08' }), NOW);
  const opened = openCapsule(capsule, new Date('2026-10-08T13:00:00.000Z'));

  assert.equal(opened.openedAt, '2026-10-08T13:00:00.000Z');
  assert.equal(capsule.openedAt, null);
  assert.equal(opened.question, capsule.question);
  assert.notEqual(opened, capsule);
});

test('saveResult requires an opened capsule and changes only progress fields', () => {
  const original = openCapsule(
    createCapsule(draft({ reviewDate: '2026-10-08' }), NOW),
    new Date('2026-10-08T13:00:00.000Z'),
  );
  const withResult = saveResult(original, '  Фактический итог: получилось.  ', new Date('2026-10-09T09:10:11.000Z'));

  assert.equal(withResult.result, 'Фактический итог: получилось.');
  assert.equal(withResult.resultUpdatedAt, '2026-10-09T09:10:11.000Z');
  assert.equal(original.result, null);
  assert.equal(withResult.id, original.id);
  assert.deepEqual(withResult.options, original.options);

  const sealed = createCapsule(draft({ reviewDate: '2026-11-01' }), NOW);
  assert.throws(() => saveResult(sealed, 'Итог', NOW), /open|открыт/i);
  assert.throws(() => saveResult(original, '   ', NOW), /result|итог/i);
});

test('validateCapsule rejects malformed records and invalid calendar dates', () => {
  assert.equal(validateCapsule(null), false);
  assert.equal(validateCapsule(createCapsule(draft({ reviewDate: '2026-11-01' }), NOW)), true);
  assert.equal(validateCapsule({ ...createCapsule(draft(), NOW), confidence: 101 }), false);
  assert.equal(validateCapsule({ ...createCapsule(draft(), NOW), reviewDate: '2026-02-30' }), false);
  assert.equal(validateCapsule({ ...createCapsule(draft(), NOW), options: [] }), false);
});

test('validateCapsule enforces a complete progress state and decision schema', () => {
  const sealed = createCapsule(draft({ reviewDate: '2026-11-01' }), NOW);
  assert.equal(validateCapsule({ ...sealed, options: ['only one'] }), false);
  assert.equal(validateCapsule({ ...sealed, confidence: 72.5 }), false);
  assert.equal(validateCapsule({ ...sealed, result: 'Есть итог' }), false);
  assert.equal(validateCapsule({ ...sealed, resultUpdatedAt: NOW.toISOString() }), false);

  const opened = openCapsule(createCapsule(draft({ reviewDate: '2026-10-08' }), NOW), NOW);
  assert.equal(validateCapsule({ ...opened, openedAt: 'not-a-timestamp' }), false);
  assert.equal(validateCapsule({ ...opened, openedAt: '2026-10-07T12:00:00.000Z' }), false);
  assert.equal(validateCapsule({ ...opened, result: 'Есть итог', resultUpdatedAt: '2026-10-08T13:00:00.000Z' }), true);
  assert.equal(validateCapsule({ ...opened, result: 'Есть итог', resultUpdatedAt: '2026-10-08T12:00:00.000Z' }), false);
  assert.equal(validateCapsule({ ...sealed, openedAt: '2026-10-08T11:00:00.000Z' }), false);
});

test('createCapsule rejects a non-canonical timestamp and normalizes confidence to an integer', () => {
  assert.throws(
    () => createCapsule(draft({ confidence: 72.5 }), NOW),
    /confidence|уверен/i,
  );
  assert.throws(
    () => createCapsule(draft({ createdAt: '2026-10-08' }), NOW),
    /createdAt|дата/i,
  );
});

test('exportJson and parseImport round-trip an archive with Unicode', () => {
  const archive = [
    createCapsule(draft({ question: 'Сменить курс? 🚲', context: 'π ≈ 3.14159' }), NOW),
    openCapsule(createCapsule(draft({ id: 'capsule-2', reviewDate: '2026-10-08' }), NOW), NOW),
  ];
  const serialized = exportJson(archive);
  const restored = parseImport(serialized);

  assert.equal(typeof serialized, 'string');
  assert.deepEqual(restored, archive);
});

test('parseImport rejects unsupported or malformed archive data', () => {
  assert.throws(() => parseImport('{"format":"other","version":1,"capsules":[]}'), /format|формат/i);
  assert.throws(() => parseImport('{"format":"decision-capsule","version":1,"capsules":[{}]}'), /capsule|капсул/i);
  assert.throws(() => parseImport('not json'), /json|формат|поврежд/i);
});

test('exportMarkdown produces a readable archive containing the original and result', () => {
  const opened = openCapsule(createCapsule(draft({ reviewDate: '2026-10-08' }), NOW), NOW);
  const withResult = saveResult(opened, 'Итог с длинной строкой.', NOW);
  const markdown = exportMarkdown([withResult]);

  assert.match(markdown, /Стоит ли менять направление/);
  assert.match(markdown, /Итог с длинной строкой/);
  assert.match(markdown, /2026-10-08/);
  assert.match(markdown, /# архив решений/);
});

test('encodeCapsule and decodeCapsule round-trip Unicode and long payloads', () => {
  const capsule = createCapsule(draft({
    question: `Очень длинный вопрос ${'🚲'.repeat(600)}`,
    context: 'Контекст с кириллицей, emoji и символами: § ✓ 漢字',
  }), NOW);
  const encoded = encodeCapsule(capsule);
  const decoded = decodeCapsule(encoded);

  assert.ok(encoded.length > 1000);
  assert.deepEqual(decoded, capsule);
  assert.throws(() => decodeCapsule('%%%'), /hash|данн|формат|base64/i);
});

test('model helpers normalize drafts and derive archive counts and review distance', () => {
  const normalized = normalizeDraft({
    question: '  Вопрос  ',
    context: null,
    options: [' A ', '', 'B'],
    chosenPath: 7,
    confidence: 0,
    reviewDate: '2026-10-15',
  });
  assert.deepEqual(normalized, {
    question: 'Вопрос',
    context: '',
    options: ['A', '', 'B'],
    chosenPath: '7',
    confidence: 0,
    reviewDate: '2026-10-15',
  });
  const sealed = createCapsule(draft({ id: 'sealed', reviewDate: '2026-10-15' }), NOW);
  const opened = openCapsule(createCapsule(draft({ id: 'opened', reviewDate: '2026-10-08' }), NOW), NOW);
  assert.deepEqual(statusCounts([sealed, opened], '2026-10-08'), { all: 2, sealed: 1, ready: 0, opened: 1 });
  assert.equal(daysUntilReview(sealed, '2026-10-08'), 7);
  assert.equal(daysUntilReview(sealed, '2026-10-20'), -5);
  const due = createCapsule(draft({ id: 'due', reviewDate: '2026-10-08' }), NOW);
  assert.deepEqual(reviewState(due, '2026-10-08'), { key: 'due', days: 0 });
  assert.deepEqual(reviewState(due, '2026-10-09'), { key: 'overdue', days: -1 });
  assert.deepEqual(reviewState(due, '2026-10-01'), { key: 'upcoming', days: 7 });
  assert.deepEqual(reviewState(opened, '2026-10-08'), { key: 'opened', days: null });
});

test('progress transitions remain monotonic and timestamps stay canonical', () => {
  const sealed = createCapsule(draft({ reviewDate: '2026-10-08' }), NOW);
  const opened = openCapsule(sealed, NOW);
  assert.throws(() => saveResult(opened, 'Итог', '2026-10-08T12:34:56Z'), /timestamp|дата/i);
  const withResult = saveResult(opened, 'Итог', '2026-10-08T13:34:56.000Z');
  assert.throws(() => saveResult(withResult, 'Поздний итог', '2026-10-08T13:00:00.000Z'), /раньше|timestamp|дата/i);
  assert.equal(validateCapsule(withResult), true);
  assert.equal(validateCapsule({ ...sealed, openedAt: NOW.toISOString(), result: 'Итог', resultUpdatedAt: '2026-10-08T12:00:00.000Z' }), false);
});

test('english markdown localizes headings while keeping authored text verbatim', () => {
  const capsule = createCapsule({ question: 'мой вопрос', context: 'мой контекст', options: ['первый', 'второй'], chosenPath: 'мой выбор', confidence: 65, reviewDate: '2099-01-01' });
  const english = exportMarkdown([capsule], 'en');
  assert.match(english, /# decision archive/);
  assert.match(english, /### context/);
  assert.match(english, /мой контекст/);
  assert.match(english, /- status: sealed/);
});
