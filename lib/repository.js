const DB_NAME = 'decision-capsule';
const DB_VERSION = 1;
const CAPSULES_STORE = 'capsules';
const SETTINGS_STORE = 'settings';
const DRAFT_KEY = 'draft';
const SEQUENCE_KEY = 'sequence';
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const IDB_UNAVAILABLE = 'локальное хранилище indexeddb недоступно. откройте сайт в современном браузере и разрешите хранение данных для этой страницы.';

function clone(value) {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function errorMessage(error, fallback = 'не удалось обратиться к локальному хранилищу.') {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function fail(message) {
  throw new Error(message);
}

function validDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validTimestamp(value) {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function localDateFromTimestamp(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Validate a sealed capsule before storing it. The model module owns domain
 * behaviour; the repository still validates persisted data so a bad import
 * cannot partially write to IndexedDB.
 */
export function validateStoredCapsule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('файл содержит капсулу неверного формата.');
  const requiredStrings = ['id', 'question', 'chosenPath', 'createdAt', 'sealedAt'];
  for (const field of requiredStrings) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      fail(`у капсулы не заполнено обязательное поле «${field}».`);
    }
  }
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.some((option) => typeof option !== 'string' || !option.trim())) {
    fail('у капсулы поле «options» должно содержать минимум два текстовых варианта.');
  }
  if (typeof value.context !== 'string') fail('у капсулы поле «context» должно быть текстом.');
  if (typeof value.confidence !== 'number' || !Number.isInteger(value.confidence) || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 100) {
    fail('у капсулы поле «confidence» должно быть числом от 0 до 100.');
  }
  if (!validDateString(value.reviewDate)) fail('у капсулы указана неверная дата пересмотра. используйте формат ГГГГ-ММ-ДД.');
  if (!validTimestamp(value.createdAt)) fail('у капсулы указана неверная дата создания.');
  if (!validTimestamp(value.sealedAt)) fail('у капсулы указана неверная дата запечатывания.');
  if (Date.parse(value.sealedAt) < Date.parse(value.createdAt)) fail('у капсулы дата запечатывания не может быть раньше даты создания.');
  if (value.openedAt !== null && !validTimestamp(value.openedAt)) fail('у капсулы поле «openedAt» должно быть датой или null.');
  if (value.openedAt !== null && Date.parse(value.openedAt) < Date.parse(value.sealedAt)) fail('у капсулы дата открытия не может быть раньше даты запечатывания.');
  if (value.openedAt !== null && localDateFromTimestamp(value.openedAt) < value.reviewDate) fail('у капсулы дата открытия не может быть раньше даты пересмотра.');
  if (value.result === null) {
    if (value.resultUpdatedAt !== null) fail('у капсулы дата обновления итога не может быть без самого итога.');
  } else {
    if (typeof value.result !== 'string' || !value.result.trim()) fail('у капсулы поле «result» должно быть непустым текстом или null.');
    if (value.openedAt === null) fail('итог нельзя сохранить до открытия капсулы.');
    if (!validTimestamp(value.resultUpdatedAt)) fail('у капсулы поле «resultUpdatedAt» должно быть датой при заполненном итоге.');
    if (Date.parse(value.resultUpdatedAt) < Date.parse(value.openedAt)) fail('дата обновления итога не может быть раньше открытия.');
  }
  if (!Number.isInteger(value.number) || value.number < 1) {
    fail('у капсулы поле «number» должно быть положительным целым числом.');
  }
  return true;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('операция indexeddb завершилась с ошибкой.'));
  });
}

function transactionToPromise(transaction, resultPromise) {
  return new Promise((resolve, reject) => {
    let result;
    let operationError;
    let settled = false;
    if (resultPromise) {
      resultPromise.then((value) => { result = value; }, (error) => {
        operationError = error;
        try { transaction.abort(); } catch { /* already finished */ }
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    }
    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(operationError || transaction.error || new Error('транзакция indexeddb завершилась с ошибкой.'));
      }
    };
    transaction.onabort = () => {
      if (!settled) {
        settled = true;
        reject(operationError || transaction.error || new Error('транзакция indexeddb была отменена.'));
      }
    };
  });
}

function openDatabase() {
  if (!globalThis.indexedDB || typeof globalThis.indexedDB.open !== 'function') {
    return Promise.reject(new Error(IDB_UNAVAILABLE));
  }
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(new Error(`${IDB_UNAVAILABLE} ${errorMessage(error)}`));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CAPSULES_STORE)) {
        db.createObjectStore(CAPSULES_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let future delete/upgrade operations proceed instead of leaving a
      // stale connection open after a second tab or a test resets the DB.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(new Error(`${IDB_UNAVAILABLE} ${errorMessage(request.error)}`));
    request.onblocked = () => reject(new Error('локальное хранилище занято другой вкладкой. закройте её и повторите попытку.'));
  });
}

function transactionError(error, fallback) {
  if (error instanceof Error && error.message) return error;
  return new Error(fallback);
}

/**
 * Open the browser-local repository. No data leaves the browser.
 */
export async function openRepository() {
  const db = await openDatabase();
  let listReport = { corrupted: [] };

  const run = (storeNames, mode, operation) => {
    let transaction;
    try {
      transaction = db.transaction(storeNames, mode);
    } catch (error) {
      return Promise.reject(transactionError(error, 'indexeddb недоступно. перезапустите страницу и повторите попытку.'));
    }
    try {
      const resultPromise = operation(transaction);
      return transactionToPromise(transaction, resultPromise).catch((error) => {
        throw transactionError(error, 'не удалось сохранить данные в локальном хранилище.');
      });
    } catch (error) {
      try { transaction.abort(); } catch { /* already finished */ }
      return Promise.reject(transactionError(error, 'не удалось сохранить данные в локальном хранилище.'));
    }
  };

  const list = async () => {
    const items = await run([CAPSULES_STORE], 'readonly', (transaction) => requestToPromise(transaction.objectStore(CAPSULES_STORE).getAll()));
    const capsules = [];
    const corrupted = [];
    for (const item of items || []) {
      try {
        validateStoredCapsule(item);
        capsules.push(clone(item));
      } catch (error) {
        corrupted.push({
          id: typeof item?.id === 'string' ? item.id : null,
          message: errorMessage(error, 'у капсулы неверный формат.'),
        });
      }
    }
    capsules.sort((left, right) => {
      const leftDate = left.sealedAt || left.createdAt || '';
      const rightDate = right.sealedAt || right.createdAt || '';
      return String(rightDate).localeCompare(String(leftDate));
    });
    // Keep the normal array API while exposing a small, non-enumerable report
    // for callers that want to tell the user which persisted rows were skipped.
    Object.defineProperties(capsules, {
      corrupted: { value: corrupted, enumerable: false },
      invalid: { value: corrupted, enumerable: false },
      report: { value: { corrupted }, enumerable: false },
    });
    listReport = { corrupted: corrupted.map((entry) => ({ ...entry })) };
    return capsules;
  };

  const addCapsule = async (capsule) => {
    validateStoredCapsule(capsule);
    const value = clone(capsule);
    try {
      return await run([CAPSULES_STORE], 'readwrite', (transaction) => {
        const store = transaction.objectStore(CAPSULES_STORE);
        // Check first so callers receive a useful conflict message instead
        // of the browser's opaque ConstraintError after the transaction aborts.
        return requestToPromise(store.get(value.id)).then((existing) => {
          if (existing) throw new Error('капсула с таким идентификатором уже существует.');
          return requestToPromise(store.add(value)).then(() => clone(value));
        });
      });
    } catch (error) {
      if (error?.name === 'ConstraintError' || /constraint|ключ/i.test(errorMessage(error))) {
        throw new Error('капсула с таким идентификатором уже существует.');
      }
      throw error;
    }
  };

  const updateProgress = async (id, progress = {}) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('укажите идентификатор капсулы для обновления.');
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
      throw new Error('данные открытия или итога имеют неверный формат.');
    }
    const allowed = ['openedAt', 'result', 'resultUpdatedAt'];
    for (const key of Object.keys(progress)) {
      if (!allowed.includes(key)) throw new Error(`поле «${key}» нельзя менять через обновление прогресса.`);
      if (key === 'openedAt' || key === 'resultUpdatedAt') {
        if (progress[key] !== null && typeof progress[key] !== 'string') throw new Error(`поле «${key}» должно быть датой или null.`);
      }
      if (key === 'result' && progress[key] !== null && typeof progress[key] !== 'string') throw new Error('поле «result» должно быть текстом или null.');
    }
    return run([CAPSULES_STORE], 'readwrite', (transaction) => {
      const store = transaction.objectStore(CAPSULES_STORE);
      return requestToPromise(store.get(id)).then((current) => {
        if (!current) throw new Error('капсула с таким идентификатором не найдена.');
        const next = { ...current };
        for (const key of allowed) if (Object.prototype.hasOwnProperty.call(progress, key)) next[key] = progress[key];
        const hasResult = Object.prototype.hasOwnProperty.call(progress, 'result');
        const hasResultUpdatedAt = Object.prototype.hasOwnProperty.call(progress, 'resultUpdatedAt');
        if (hasResult !== hasResultUpdatedAt) {
          throw new Error('текст итога и дата обновления должны передаваться вместе.');
        }
        if (Object.prototype.hasOwnProperty.call(progress, 'openedAt')) {
          if (progress.openedAt === null && current.openedAt !== null) throw new Error('нельзя закрыть уже открытую капсулу или откатить переход.');
          if (progress.openedAt !== null) {
            if (!validTimestamp(progress.openedAt)) throw new Error('поле «openedAt» должно быть канонической датой ISO (timestamp).');
            if (current.openedAt !== null && progress.openedAt !== current.openedAt) throw new Error('нельзя изменить дату открытия капсулы.');
            if (new Date(progress.openedAt) < new Date(current.sealedAt)) throw new Error('капсулу нельзя открыть раньше даты запечатывания.');
            if (localDateFromTimestamp(progress.openedAt) < current.reviewDate) throw new Error('капсулу нельзя открыть раньше даты пересмотра.');
          }
        }
        if (hasResult) {
          if (next.openedAt === null) throw new Error('сначала откройте капсулу, затем добавьте итог.');
          if (progress.result === null && current.result !== null) throw new Error('нельзя удалить уже сохранённый итог.');
          if (typeof progress.result !== 'string' || !progress.result.trim()) throw new Error('итог должен быть непустым текстом.');
        }
        if (hasResultUpdatedAt) {
          if (progress.resultUpdatedAt === null && current.resultUpdatedAt !== null) throw new Error('нельзя удалить дату сохранённого итога.');
          if (!validTimestamp(progress.resultUpdatedAt)) throw new Error('поле «resultUpdatedAt» должно быть канонической датой ISO (timestamp).');
          if (next.openedAt === null || next.result === null) throw new Error('дата итога возможна только вместе с открытием и текстом итога.');
          if (new Date(progress.resultUpdatedAt) < new Date(next.openedAt)) throw new Error('дата итога не может быть раньше открытия.');
          if (current.resultUpdatedAt && new Date(progress.resultUpdatedAt) < new Date(current.resultUpdatedAt)) throw new Error('нельзя сохранить итог датой раньше предыдущего итога.');
        }
        validateStoredCapsule(next);
        return requestToPromise(store.put(next)).then(() => clone(next));
      });
    });
  };

  const sealCapsule = async (capsule, draft = null) => {
    validateStoredCapsule(capsule);
    const value = clone(capsule);
    return run([CAPSULES_STORE, SETTINGS_STORE], 'readwrite', (transaction) => {
      const capsuleStore = transaction.objectStore(CAPSULES_STORE);
      const settingsStore = transaction.objectStore(SETTINGS_STORE);
      return requestToPromise(capsuleStore.get(value.id)).then((existing) => {
        if (existing) throw new Error('капсула с таким идентификатором уже существует.');
        return Promise.all([
          requestToPromise(capsuleStore.getAll()),
          requestToPromise(settingsStore.get(SEQUENCE_KEY)),
        ]).then(([rows, sequence]) => {
          const maxStored = Math.max(0, ...(rows || []).map((row) => Number(row.number) || 0));
          const lastAssigned = Number(sequence?.value) || 0;
          value.number = Math.max(maxStored, lastAssigned, Number(value.number) - 1) + 1;
          validateStoredCapsule(value);
          return requestToPromise(capsuleStore.add(value))
            .then(() => requestToPromise(settingsStore.put({ key: SEQUENCE_KEY, value: value.number })))
            .then(() => requestToPromise(settingsStore.delete(DRAFT_KEY)))
            .then(() => clone(value));
        });
      });
    });
  };

  const importCapsules = async (payload) => {
    if (!Array.isArray(payload) && payload && Array.isArray(payload.capsules)) {
      if (payload.format !== 'decision-capsule') {
        throw new Error('не удалось импортировать файл: неизвестный формат архива.');
      }
      if (payload.version !== 1) {
        throw new Error('не удалось импортировать файл: эта версия архива не поддерживается.');
      }
    }
    const entries = Array.isArray(payload) ? payload : payload && Array.isArray(payload.capsules) ? payload.capsules : null;
    if (!entries) throw new Error('не удалось импортировать файл: ожидается список капсул.');
    const values = entries.map((entry) => {
      validateStoredCapsule(entry);
      return clone(entry);
    });
    return run([CAPSULES_STORE, SETTINGS_STORE], 'readwrite', async (transaction) => {
      const store = transaction.objectStore(CAPSULES_STORE);
      const settingsStore = transaction.objectStore(SETTINGS_STORE);
      const [rows, sequence] = await Promise.all([
        requestToPromise(store.getAll()),
        requestToPromise(settingsStore.get(SEQUENCE_KEY)),
      ]);
      const usedNumbers = new Set((rows || []).map((row) => Number(row.number)).filter((number) => Number.isInteger(number) && number > 0));
      const lastAssigned = Number(sequence?.value) || 0;
      let nextNumber = Math.max(lastAssigned, ...usedNumbers, 0);
      let imported = 0;
      let skipped = 0;
      const seen = new Set();
      for (const source of values) {
        const value = clone(source);
        if (seen.has(value.id)) {
          skipped += 1;
          continue;
        }
        seen.add(value.id);
        const existing = await requestToPromise(store.get(value.id));
        if (existing) {
          skipped += 1;
          continue;
        }
        if (usedNumbers.has(value.number)) {
          do { nextNumber += 1; } while (usedNumbers.has(nextNumber));
          value.number = nextNumber;
        }
        usedNumbers.add(value.number);
        nextNumber = Math.max(nextNumber, value.number);
        await requestToPromise(store.add(value));
        imported += 1;
      }
      if (imported && nextNumber > lastAssigned) {
        await requestToPromise(settingsStore.put({ key: SEQUENCE_KEY, value: nextNumber }));
      }
      return { imported, skipped };
    });
  };

  const getDraft = async () => run([SETTINGS_STORE], 'readonly', (transaction) => requestToPromise(transaction.objectStore(SETTINGS_STORE).get(DRAFT_KEY)).then((entry) => entry ? clone(entry.value) : null));

  const setDraft = async (draft) => {
    const value = clone(draft);
    await run([SETTINGS_STORE], 'readwrite', (transaction) => requestToPromise(transaction.objectStore(SETTINGS_STORE).put({ key: DRAFT_KEY, value })));
    return value;
  };
  const saveDraft = setDraft;

  const clearDraft = async () => {
    await run([SETTINGS_STORE], 'readwrite', (transaction) => requestToPromise(transaction.objectStore(SETTINGS_STORE).delete(DRAFT_KEY)));
  };

  return {
    list,
    get listReport() { return { corrupted: listReport.corrupted.map((entry) => ({ ...entry })) }; },
    addCapsule,
    sealCapsule,
    updateProgress,
    importCapsules,
    getDraft,
    setDraft,
    saveDraft,
    clearDraft,
    close: () => db.close(),
  };
}

export { DB_NAME };
