function requireString(value) {
  if (typeof value !== 'string') throw new TypeError('A barcode value must be a string.');
}

// Stores confirmed successes only. In-flight and uncertain values remain owned
// by ScanQueue and are inspected from its snapshot when checking a new scan.
export class DuplicateHistory {
  #successes;

  constructor(initialValues = []) {
    if (!Array.isArray(initialValues)) throw new TypeError('Duplicate history must be an array of strings.');
    for (const value of initialValues) requireString(value);
    this.#successes = new Set(initialValues);
  }

  get size() { return this.#successes.size; }

  recordSuccess(value) {
    requireString(value);
    const added = !this.#successes.has(value);
    this.#successes.add(value);
    return added;
  }

  find(value, snapshot = {}) {
    requireString(value);
    if (snapshot?.active?.job?.value === value) return { reason: 'printing' };
    if (snapshot?.pending?.some(item => item?.job?.value === value)) return { reason: 'queued' };
    if (snapshot?.uncertain?.some(item => item?.job?.value === value)) return { reason: 'uncertain' };
    return this.#successes.has(value) ? { reason: 'printed' } : null;
  }

  clear() {
    const removed = this.#successes.size;
    this.#successes.clear();
    return removed;
  }

  toJSON() { return [...this.#successes]; }
}
