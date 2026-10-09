import { getStatus } from './model.js';

const SEARCH_FIELDS = ['question', 'context', 'chosenPath', 'result'];

export function searchableText(capsule) {
  return SEARCH_FIELDS.map((field) => capsule[field]).concat(capsule.options || [])
    .map((value) => String(value ?? '')).join(' ').toLocaleLowerCase('ru-RU');
}

export function filterAndSortCapsules(capsules, { today, filter = 'all', search = '', sort = 'review-asc' } = {}) {
  const query = String(search).trim().toLocaleLowerCase('ru-RU');
  const filtered = capsules.filter((capsule) => {
    const status = getStatus(capsule, today);
    return (filter === 'all' || status === filter) && (!query || searchableText(capsule).includes(query));
  });
  return [...filtered].sort((left, right) => {
    if (sort === 'created-desc') return String(right.createdAt).localeCompare(String(left.createdAt));
    if (sort === 'created-asc') return String(left.createdAt).localeCompare(String(right.createdAt));
    if (sort === 'review-desc') return String(right.reviewDate).localeCompare(String(left.reviewDate));
    return String(left.reviewDate).localeCompare(String(right.reviewDate)) || Number(left.number) - Number(right.number);
  });
}

export function summarizeArchive(capsules, today) {
  const summary = { all: capsules.length, sealed: 0, ready: 0, opened: 0 };
  capsules.forEach((capsule) => { summary[getStatus(capsule, today)] += 1; });
  return summary;
}
