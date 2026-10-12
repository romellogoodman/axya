/*
 * A CPython set of non-negative ints, reproducing its iteration order.
 *
 * Ported from CPython 3.14 Objects/setobject.c (set_add_entry,
 * set_insert_clean, set_table_resize, set_lookkey, set_discard_entry,
 * set_merge_lock_held, iteration).
 * Copyright (c) 2001 Python Software Foundation; All Rights Reserved.
 * Licensed under the Python Software Foundation License Version 2;
 * distributed here under AGPL-3.0 as part of axya.
 *
 * clipping.py iterates sets of path indices (rtree and grid query results)
 * and the order decides which split pieces get which ids, so the table
 * layout (open addressing, linear probes, perturbation, resizes and dummy
 * entries) is modelled exactly. For an int 0 <= n < 2^61 - 1, hash(n) == n.
 */

const MINSIZE = 8;
const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5;
const EMPTY = -1; // a NULL key
const DUMMY = -2; // the dummy key of a discarded entry

export class PySet {
  private table: number[] = new Array(MINSIZE).fill(EMPTY);
  private mask = MINSIZE - 1;
  private fill = 0; // active + dummy
  private used = 0; // active

  constructor(items?: Iterable<number>) {
    // set(iterable): set_update_local with a non-set iterable adds each.
    if (items) for (const k of items) this.add(k);
  }

  get size(): number {
    return this.used;
  }

  /** set_add_entry */
  add(key: number): void {
    const hash = key;
    const mask = this.mask;
    let i = hash & mask;
    let freeslot = -1;
    let perturb = hash;
    let entry: number;
    for (;;) {
      entry = i;
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      do {
        const k = this.table[entry];
        if (k === EMPTY) {
          if (freeslot !== -1) {
            this.used++;
            this.table[freeslot] = key;
            return;
          }
          this.fill++;
          this.used++;
          this.table[entry] = key;
          if (this.fill * 5 < mask * 3) return;
          this.resize(this.used > 50000 ? this.used * 2 : this.used * 4);
          return;
        }
        if (k === key) return;
        if (k === DUMMY) freeslot = entry;
        entry++;
      } while (probes--);
      perturb = Math.floor(perturb / 2 ** PERTURB_SHIFT);
      i = (i * 5 + 1 + perturb) % (mask + 1);
    }
  }

  /** set_lookkey: the slot holding key, or -1. */
  private lookup(key: number): number {
    const mask = this.mask;
    let i = key & mask;
    let perturb = key;
    for (;;) {
      let entry = i;
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      do {
        const k = this.table[entry];
        if (k === EMPTY) return -1;
        if (k === key) return entry;
        entry++;
      } while (probes--);
      perturb = Math.floor(perturb / 2 ** PERTURB_SHIFT);
      i = (i * 5 + 1 + perturb) % (mask + 1);
    }
  }

  has(key: number): boolean {
    return this.lookup(key) !== -1;
  }

  /** set.discard (set_discard_entry): leaves a dummy entry. */
  discard(key: number): void {
    const slot = this.lookup(key);
    if (slot === -1) return;
    this.table[slot] = DUMMY;
    this.used--;
  }

  /** set_insert_clean */
  private static insertClean(table: number[], mask: number, key: number) {
    let perturb = key;
    let i = key & mask;
    for (;;) {
      let entry = i;
      if (table[entry] === EMPTY) {
        table[entry] = key;
        return;
      }
      if (i + LINEAR_PROBES <= mask) {
        for (let j = 0; j < LINEAR_PROBES; j++) {
          entry++;
          if (table[entry] === EMPTY) {
            table[entry] = key;
            return;
          }
        }
      }
      perturb = Math.floor(perturb / 2 ** PERTURB_SHIFT);
      i = (i * 5 + 1 + perturb) % (mask + 1);
    }
  }

  /** set_table_resize */
  private resize(minused: number): void {
    let newsize = MINSIZE;
    while (newsize <= minused) newsize *= 2;
    const old = this.table;
    if (
      newsize === MINSIZE &&
      old.length === MINSIZE &&
      this.fill === this.used
    )
      return; // no dummies, so no point doing anything
    const table: number[] = new Array(newsize).fill(EMPTY);
    this.mask = newsize - 1;
    this.table = table;
    this.fill = this.used;
    for (const k of old) {
      if (k !== EMPTY && k !== DUMMY) PySet.insertClean(table, this.mask, k);
    }
  }

  /** set |= other, set.update(other) (set_merge_lock_held) */
  update(other: PySet): void {
    if (other === this || other.used === 0) return;
    if ((this.fill + other.used) * 5 >= this.mask * 3)
      this.resize((this.used + other.used) * 2);
    if (
      this.fill === 0 &&
      this.mask === other.mask &&
      other.fill === other.used
    ) {
      this.table = other.table.slice();
      this.fill = other.fill;
      this.used = other.used;
      return;
    }
    if (this.fill === 0) {
      this.fill = other.used;
      this.used = other.used;
      for (const k of other.table) {
        if (k !== EMPTY && k !== DUMMY)
          PySet.insertClean(this.table, this.mask, k);
      }
      return;
    }
    for (const k of other.table) {
      if (k !== EMPTY && k !== DUMMY) this.add(k);
    }
  }

  /** Iteration: table order, skipping empty and dummy slots. */
  *[Symbol.iterator](): IterableIterator<number> {
    for (const k of this.table) if (k !== EMPTY && k !== DUMMY) yield k;
  }
}
