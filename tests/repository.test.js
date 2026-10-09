import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { openRepository } from '../lib/repository.js';

const DB_NAME = 'decision-capsule';

function capsule(overrides = {}) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    number: overrides.number ?? 1,
    question: overrides.question ?? 'Какой путь выбрать?',
    context: overrides.context ?? 'Контекст решения',
    options: overrides.options ?? ['Вариант A', 'Вариант B'],
    chosenPath: overrides.chosenPath ?? 'Вариант A',
    confidence: overrides.confidence ?? 70,
    reviewDate: overrides.reviewDate ?? '2099-12-31',
    createdAt: overrides.createdAt ?? '2026-10-08T08:00:00.000Z',
    sealedAt: overrides.sealedAt ?? '2026-10-08T08:00:00.000Z',
    openedAt: overrides.openedAt ?? null,
    result: overrides.result ?? null,
    resultUpdatedAt: overrides.resultUpdatedAt ?? null,
  };
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
});

afterEach(async () => {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
});

test('adds and lists capsules, preserving their fields', async () => {
  const repo = await openRepository();
  const item = capsule({ id: 'one' });

  const saved = await repo.addCapsule(item);
  assert.deepEqual(saved, item);
  item.question = 'изменено снаружи';

  const listed = await repo.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'one');
  assert.equal(listed[0].question, 'Какой путь выбрать?');
});

test('persists records across repository instances', async () => {
  const repo = await openRepository();
  await repo.addCapsule(capsule({ id: 'persisted' }));

  const second = await openRepository();
  const listed = await second.list();
  assert.equal(listed.some((item) => item.id === 'persisted'), true);
});

test('rejects duplicate ids without replacing the original', async () => {
  const repo = await openRepository();
  const original = capsule({ id: 'same', question: 'Оригинальный вопрос' });
  await repo.addCapsule(original);

  await assert.rejects(
    repo.addCapsule(capsule({ id: 'same', question: 'Подмена' })),
    /уже существует|дубликат/i,
  );

  const [saved] = await repo.list();
  assert.equal(saved.question, 'Оригинальный вопрос');
});

test('updates only progress fields and keeps original fields immutable', async () => {
  const repo = await openRepository();
  const original = capsule({ id: 'progress', reviewDate: '2026-10-08', question: 'Неизменный вопрос', chosenPath: 'A' });
  await repo.addCapsule(original);

  const changed = await repo.updateProgress('progress', {
    openedAt: '2026-10-09T10:00:00.000Z',
    result: 'Фактический итог',
    resultUpdatedAt: '2026-10-09T10:00:00.000Z',
  });

  assert.equal(changed.openedAt, '2026-10-09T10:00:00.000Z');
  assert.equal(changed.result, 'Фактический итог');
  assert.equal(changed.question, 'Неизменный вопрос');
  assert.equal(changed.chosenPath, 'A');
});

test('rejects invalid progress transitions and leaves the stored capsule unchanged', async () => {
  const repo = await openRepository();
  await repo.addCapsule(capsule({ id: 'strict-progress', reviewDate: '2099-12-31' }));

  await assert.rejects(repo.updateProgress('strict-progress', { openedAt: 'not-a-date' }), /дата|формат|timestamp/i);
  await assert.rejects(repo.updateProgress('strict-progress', { openedAt: '2026-10-07T10:00:00.000Z' }), /дата|раньше|откры/i);
  await assert.rejects(repo.updateProgress('strict-progress', { result: 'Итог' }), /откры|result|итог/i);
  await assert.rejects(repo.updateProgress('strict-progress', { resultUpdatedAt: '2026-10-08T10:00:00.000Z' }), /result|итог/i);

  const [unchanged] = await repo.list();
  assert.equal(unchanged.openedAt, null);
  assert.equal(unchanged.result, null);
  assert.equal(unchanged.resultUpdatedAt, null);
});

test('rejects unknown progress fields instead of silently ignoring them', async () => {
  const repo = await openRepository();
  await repo.addCapsule(capsule({ id: 'strict-fields' }));

  await assert.rejects(
    repo.updateProgress('strict-fields', { question: 'Попытка изменить вопрос' }),
    /поле|формат|progress/i,
  );
  const [unchanged] = await repo.list();
  assert.equal(unchanged.question, 'Какой путь выбрать?');
});

test('rejects progress updates for an unknown id', async () => {
  const repo = await openRepository();
  await assert.rejects(repo.updateProgress('missing', { openedAt: new Date().toISOString() }), /не найдена|не найдена/i);
});

test('imports valid capsules atomically and skips existing ids', async () => {
  const repo = await openRepository();
  const existing = capsule({ id: 'existing', question: 'Локальная версия' });
  await repo.addCapsule(existing);
  const incoming = capsule({ id: 'existing', question: 'Импортированная версия' });
  const fresh = capsule({ id: 'fresh', number: 2 });

  const result = await repo.importCapsules([incoming, fresh]);
  assert.deepEqual(result, { imported: 1, skipped: 1 });

  const listed = await repo.list();
  assert.equal(listed.length, 2);
  assert.equal(listed.find((item) => item.id === 'existing').question, 'Локальная версия');
  assert.equal(listed.find((item) => item.id === 'fresh').number, 2);
});

test('renumbers imported capsules when their display number is already used', async () => {
  const repo = await openRepository();
  await repo.addCapsule(capsule({ id: 'number-owner', number: 4 }));

  const result = await repo.importCapsules([
    capsule({ id: 'number-collision-a', number: 4 }),
    capsule({ id: 'number-collision-b', number: 5 }),
  ]);

  assert.deepEqual(result, { imported: 2, skipped: 0 });
  const listed = await repo.list();
  assert.equal(listed.find((item) => item.id === 'number-collision-a').number, 5);
  assert.equal(listed.find((item) => item.id === 'number-collision-b').number, 6);
});

test('validates the complete import before writing anything', async () => {
  const repo = await openRepository();
  const valid = capsule({ id: 'valid' });
  const invalid = { id: 'broken', question: '' };

  await assert.rejects(repo.importCapsules([valid, invalid]), /импорт|формат|поле/i);
  assert.deepEqual(await repo.list(), []);
});

test('rolls back every imported record when a transaction write fails', async () => {
  const repo = await openRepository();
  const originalAdd = IDBObjectStore.prototype.add;
  let writes = 0;
  IDBObjectStore.prototype.add = function addWithFailure(value) {
    writes += 1;
    if (writes === 2) throw new Error('synthetic write failure');
    return originalAdd.call(this, value);
  };

  try {
    await assert.rejects(
      repo.importCapsules([capsule({ id: 'atomic-a' }), capsule({ id: 'atomic-b' })]),
      /synthetic write failure/,
    );
  } finally {
    IDBObjectStore.prototype.add = originalAdd;
  }

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await repo.list(), []);
});

test('rejects an unsupported import envelope before opening a write transaction', async () => {
  const repo = await openRepository();
  await assert.rejects(
    repo.importCapsules({ format: 'other', version: 1, capsules: [capsule({ id: 'wrong-format' })] }),
    /формат/i,
  );
  assert.deepEqual(await repo.list(), []);
});

test('stores, reads, and clears the local draft', async () => {
  const repo = await openRepository();
  const draft = { question: 'Черновой вопрос', confidence: 55 };
  await repo.setDraft(draft);
  draft.question = 'изменено снаружи';

  assert.deepEqual(await repo.getDraft(), { question: 'Черновой вопрос', confidence: 55 });
  await repo.clearDraft();
  assert.equal(await repo.getDraft(), null);
});

test('returns an actionable Russian error when IndexedDB is unavailable', async () => {
  const original = globalThis.indexedDB;
  try {
    globalThis.indexedDB = undefined;
    await assert.rejects(openRepository(), /IndexedDB|хранилищ|браузер/i);
  } finally {
    globalThis.indexedDB = original;
  }
});

test('seals a capsule and clears its draft in one transaction', async () => {
  const repo = await openRepository();
  const item = capsule({ id: 'sealed-with-draft', number: 4 });
  await repo.setDraft({ question: 'Черновик', confidence: 0 });

  const saved = await repo.sealCapsule(item, { question: 'Черновик' });
  assert.deepEqual(saved, item);
  assert.equal((await repo.list()).length, 1);
  assert.equal(await repo.getDraft(), null);
});

test('assigns a unique display number while sealing a capsule', async () => {
  const repo = await openRepository();
  await repo.addCapsule(capsule({ id: 'existing-number', number: 9 }));
  const incoming = capsule({ id: 'next-number', number: 1 });

  const saved = await repo.sealCapsule(incoming);

  assert.equal(saved.number, 10);
  assert.equal((await repo.list()).find((item) => item.id === 'next-number').number, 10);
});

test('does not move progress backwards or accept non-canonical timestamps', async () => {
  const repo = await openRepository();
  await repo.addCapsule(capsule({ id: 'monotonic', reviewDate: '2026-10-08' }));

  await assert.rejects(repo.updateProgress('monotonic', { openedAt: '2026-10-08T10:00:00Z' }), /дата|формат|timestamp/i);
  await repo.updateProgress('monotonic', { openedAt: '2026-10-08T10:00:00.000Z' });
  await assert.rejects(repo.updateProgress('monotonic', { openedAt: null }), /откры|переход|формат/i);
  await repo.updateProgress('monotonic', { result: 'Итог', resultUpdatedAt: '2026-10-08T11:00:00.000Z' });
  await assert.rejects(repo.updateProgress('monotonic', { result: 'Назад', resultUpdatedAt: '2026-10-08T10:30:00.000Z' }), /раньше|timestamp|дата/i);
});

test('isolates a damaged persisted row in the list report', async () => {
  const repo = await openRepository();
  const invalid = { ...capsule({ id: 'damaged' }), confidence: 72.5 };
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('capsules', 'readwrite');
      transaction.objectStore('capsules').put(invalid);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  });
  const listed = await repo.list();
  assert.deepEqual([...listed], []);
  assert.equal(listed.corrupted.length, 1);
  assert.equal(listed.corrupted[0].id, 'damaged');
});

test('rejects an unversioned import envelope', async () => {
  const repo = await openRepository();
  await assert.rejects(
    repo.importCapsules({ capsules: [capsule({ id: 'unversioned' })] }),
    /формат|верси/i,
  );
  assert.deepEqual(await repo.list(), []);
});

test('does not allow storage opening before the review date', async () => {
  const repo = await openRepository();
  await repo.addCapsule(capsule({ id: 'future-review', reviewDate: '2099-12-31' }));
  await assert.rejects(
    repo.updateProgress('future-review', { openedAt: '2026-10-08T10:00:00.000Z' }),
    /дата|раньше|откры/i,
  );
});
