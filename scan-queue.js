// One captured label per accepted scan. An uncertain print is never retried here.
function freezeTree(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeTree(child, seen);
  return Object.freeze(value);
}

export class ScanQueue {
  constructor({ send, canSend = () => true, onChange = () => {}, maxPending = 50 } = {}) {
    if (typeof send !== 'function') throw new TypeError('A print function is required.');
    if (typeof canSend !== 'function' || typeof onChange !== 'function') throw new TypeError('Queue callbacks must be functions.');
    if (!Number.isInteger(maxPending) || maxPending < 1) throw new RangeError('Queue capacity must be a positive integer.');
    this.send = send;
    this.canSend = canSend;
    this.onChange = onChange;
    this.maxPending = maxPending;
    this.pending = [];
    this.active = null;
    this.uncertain = [];
    this.completedCount = 0;
    this.lastCompleted = null;
    this.paused = false;
    this.pauseReason = '';
    this.nextId = 1;
    this.running = false;
  }

  snapshot() {
    // Jobs are immutable; copy list containers so a UI cannot alter queue order.
    return Object.freeze({
      paused: this.paused,
      pauseReason: this.pauseReason,
      pending: Object.freeze([...this.pending]),
      active: this.active,
      uncertain: Object.freeze([...this.uncertain]),
      completedCount: this.completedCount,
      lastCompleted: this.lastCompleted,
    });
  }

  enqueue(job) {
    if (!this.canSend()) throw new Error('Connect the M211 before scanning a label.');
    if (this.pending.length >= this.maxPending) throw new Error(`The queue already has ${this.maxPending} waiting labels. Wait before scanning again.`);
    if (!job || typeof job !== 'object' || Array.isArray(job)) throw new TypeError('A label job is required.');
    const item = Object.freeze({ id: this.nextId++, job: freezeTree(structuredClone(job)) });
    this.pending.push(item);
    this.emit();
    this.kick();
    return item.id;
  }

  pause(reason = 'Printing paused.') {
    this.paused = true;
    this.pauseReason = String(reason);
    this.emit();
    // An in-flight write cannot be safely cancelled. It must settle before any
    // other job can run, even if resume() is selected in the meantime.
  }

  resume() {
    if (!this.canSend()) throw new Error('Reconnect the M211 before resuming the queue.');
    this.paused = false;
    this.pauseReason = '';
    this.emit();
    this.kick();
  }

  clearPending() {
    const removed = this.pending.length;
    this.pending = [];
    this.emit();
    return removed;
  }

  emit() {
    try { this.onChange(this.snapshot()); }
    catch (error) { console.error('Print queue observer failed:', error); }
  }

  kick() {
    if (this.running || this.paused || !this.pending.length) return;
    this.running = true;
    void this.drain();
  }

  async drain() {
    try {
      while (!this.paused && this.pending.length) {
        if (!this.canSend()) {
          this.pause('Printer disconnected. Reconnect, then resume waiting labels.');
          break;
        }
        const item = this.pending.shift();
        this.active = item;
        this.emit();
        try {
          const success = await this.send(item.job);
          if (success !== true) throw new Error('The printer did not confirm success. Check the physical label before printing it again.');
          this.completedCount++;
          this.lastCompleted = item;
        } catch (error) {
          this.uncertain.push(Object.freeze({
            ...item,
            error: error instanceof Error ? error.message : String(error),
          }));
          this.paused = true;
          this.pauseReason = 'A print result is uncertain. Check the printer before resuming waiting labels. The uncertain label will not be retried.';
        } finally {
          this.active = null;
          this.emit();
        }
      }
    } catch (error) {
      // A faulty availability callback must not produce an unhandled promise
      // rejection or silently discard the jobs that have not been sent.
      this.pause(`Queue paused: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
      // onChange may synchronously enqueue or resume at the final notification.
      this.kick();
    }
  }
}
