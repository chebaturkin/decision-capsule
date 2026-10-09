import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSortCapsules, summarizeArchive } from '../lib/selectors.js';

const items = [
  { id: 'ready', number: 2, question: 'Новый формат', context: 'Команда', options: ['A', 'B'], chosenPath: 'A', reviewDate: '2026-10-08', createdAt: '2026-10-01T10:00:00.000Z', sealedAt: '2026-10-01T10:00:00.000Z', openedAt: null, result: null, resultUpdatedAt: null, confidence: 50 },
  { id: 'sealed', number: 1, question: 'Старый путь', context: 'Рынок', options: ['C', 'D'], chosenPath: 'D', reviewDate: '2026-11-08', createdAt: '2026-10-02T10:00:00.000Z', sealedAt: '2026-10-02T10:00:00.000Z', openedAt: null, result: null, resultUpdatedAt: null, confidence: 60 },
  { id: 'opened', number: 3, question: 'Результат', context: 'Клиенты', options: ['E', 'F'], chosenPath: 'E', reviewDate: '2026-09-08', createdAt: '2026-09-03T10:00:00.000Z', sealedAt: '2026-09-03T10:00:00.000Z', openedAt: '2026-09-08T10:00:00.000Z', result: 'Сработало', resultUpdatedAt: '2026-09-10T10:00:00.000Z', confidence: 80 },
];

test('filters ready items with search and includes every searchable field', () => {
  const result = filterAndSortCapsules(items, { today: '2026-10-08', filter: 'all', search: 'сработало', sort: 'review-asc' });
  assert.deepEqual(result.map((item) => item.id), ['opened']);
});

test('sorts all sections consistently and summarizes counts', () => {
  const result = filterAndSortCapsules(items, { today: '2026-10-08', filter: 'all', search: '', sort: 'review-asc' });
  assert.deepEqual(result.map((item) => item.id), ['opened', 'ready', 'sealed']);
  assert.deepEqual(summarizeArchive(items, '2026-10-08'), { all: 3, sealed: 1, ready: 1, opened: 1 });
});
