/*
 * std::sort as libc++ 19.1.2 implements it, for a non-arithmetic element
 * type with a custom comparator (Clipper 6.4.2 sorts its local minima and
 * intersection lists this way, and the order of equal elements shows in its
 * output).
 *
 * Ported from LLVM libc++ 19.1.2 <__algorithm/sort.h> (__introsort, the
 * branching __sort3/__sort4/__sort5, __insertion_sort,
 * __insertion_sort_unguarded, __insertion_sort_incomplete,
 * __partition_with_equals_on_right/_left), <__algorithm/partial_sort.h>,
 * <__algorithm/make_heap.h>, <__algorithm/sort_heap.h>,
 * <__algorithm/pop_heap.h>, <__algorithm/push_heap.h> and
 * <__algorithm/sift_down.h>.
 * Part of the LLVM Project, under the Apache License v2.0 with LLVM
 * Exceptions; distributed here under AGPL-3.0 as part of axya.
 *
 * Iterators are array indices. Only the resulting permutation matters, so
 * moves are plain assignments.
 */

type Comp<T> = (x: T, y: T) => boolean;

function swap<T>(a: T[], i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

function sort3<T>(a: T[], x: number, y: number, z: number, c: Comp<T>): void {
  if (!c(a[y], a[x])) {
    if (!c(a[z], a[y])) return;
    swap(a, y, z);
    if (c(a[y], a[x])) swap(a, x, y);
    return;
  }
  if (c(a[z], a[y])) {
    swap(a, x, z);
    return;
  }
  swap(a, x, y);
  if (c(a[z], a[y])) swap(a, y, z);
}

function sort4<T>(
  a: T[],
  x1: number,
  x2: number,
  x3: number,
  x4: number,
  c: Comp<T>
): void {
  sort3(a, x1, x2, x3, c);
  if (c(a[x4], a[x3])) {
    swap(a, x3, x4);
    if (c(a[x3], a[x2])) {
      swap(a, x2, x3);
      if (c(a[x2], a[x1])) swap(a, x1, x2);
    }
  }
}

function sort5<T>(
  a: T[],
  x1: number,
  x2: number,
  x3: number,
  x4: number,
  x5: number,
  c: Comp<T>
): void {
  sort4(a, x1, x2, x3, x4, c);
  if (c(a[x5], a[x4])) {
    swap(a, x4, x5);
    if (c(a[x4], a[x3])) {
      swap(a, x3, x4);
      if (c(a[x3], a[x2])) {
        swap(a, x2, x3);
        if (c(a[x2], a[x1])) swap(a, x1, x2);
      }
    }
  }
}

function insertionSort<T>(
  a: T[],
  first: number,
  last: number,
  c: Comp<T>
): void {
  if (first === last) return;
  for (let i = first + 1; i !== last; ++i) {
    let j = i - 1;
    if (c(a[i], a[j])) {
      const t = a[i];
      let k = j;
      j = i;
      do {
        a[j] = a[k];
        j = k;
      } while (j !== first && c(t, a[--k]));
      a[j] = t;
    }
  }
}

function insertionSortUnguarded<T>(
  a: T[],
  first: number,
  last: number,
  c: Comp<T>
): void {
  if (first === last) return;
  for (let i = first + 1; i !== last; ++i) {
    let j = i - 1;
    if (c(a[i], a[j])) {
      const t = a[i];
      let k = j;
      j = i;
      do {
        a[j] = a[k];
        j = k;
      } while (c(t, a[--k]));
      a[j] = t;
    }
  }
}

function insertionSortIncomplete<T>(
  a: T[],
  first: number,
  last: number,
  c: Comp<T>
): boolean {
  switch (last - first) {
    case 0:
    case 1:
      return true;
    case 2:
      if (c(a[last - 1], a[first])) swap(a, first, last - 1);
      return true;
    case 3:
      sort3(a, first, first + 1, last - 1, c);
      return true;
    case 4:
      sort4(a, first, first + 1, first + 2, last - 1, c);
      return true;
    case 5:
      sort5(a, first, first + 1, first + 2, first + 3, last - 1, c);
      return true;
  }
  let j = first + 2;
  sort3(a, first, first + 1, j, c);
  const limit = 8;
  let count = 0;
  for (let i = j + 1; i !== last; ++i) {
    if (c(a[i], a[j])) {
      const t = a[i];
      let k = j;
      j = i;
      do {
        a[j] = a[k];
        j = k;
      } while (j !== first && c(t, a[--k]));
      a[j] = t;
      if (++count === limit) return i + 1 === last;
    }
    j = i;
  }
  return true;
}

function partitionWithEqualsOnRight<T>(
  a: T[],
  first: number,
  last: number,
  c: Comp<T>
): [number, boolean] {
  const begin = first;
  const pivot = a[first];
  do {
    ++first;
  } while (c(a[first], pivot));
  if (begin === first - 1) {
    while (first < last && !c(a[--last], pivot));
  } else {
    do {
      --last;
    } while (!c(a[last], pivot));
  }
  const alreadyPartitioned = first >= last;
  while (first < last) {
    swap(a, first, last);
    do {
      ++first;
    } while (c(a[first], pivot));
    do {
      --last;
    } while (!c(a[last], pivot));
  }
  const pivotPos = first - 1;
  if (begin !== pivotPos) a[begin] = a[pivotPos];
  a[pivotPos] = pivot;
  return [pivotPos, alreadyPartitioned];
}

function partitionWithEqualsOnLeft<T>(
  a: T[],
  first: number,
  last: number,
  c: Comp<T>
): number {
  const begin = first;
  const pivot = a[first];
  if (c(pivot, a[last - 1])) {
    do {
      ++first;
    } while (!c(pivot, a[first]));
  } else {
    while (++first < last && !c(pivot, a[first]));
  }
  if (first < last) {
    do {
      --last;
    } while (c(pivot, a[last]));
  }
  while (first < last) {
    swap(a, first, last);
    do {
      ++first;
    } while (!c(pivot, a[first]));
    do {
      --last;
    } while (c(pivot, a[last]));
  }
  const pivotPos = first - 1;
  if (begin !== pivotPos) a[begin] = a[pivotPos];
  a[pivotPos] = pivot;
  return first;
}

/** __sift_down (not assuming both children), on a heap at a[first..]. */
function siftDown<T>(
  a: T[],
  first: number,
  c: Comp<T>,
  len: number,
  start: number
): void {
  let child = start;
  if (len < 2 || Math.trunc((len - 2) / 2) < child) return;
  child = 2 * child + 1;
  if (child + 1 < len && c(a[first + child], a[first + child + 1])) ++child;
  if (c(a[first + child], a[first + start])) return;
  const top = a[first + start];
  do {
    a[first + start] = a[first + child];
    start = child;
    if (Math.trunc((len - 2) / 2) < child) break;
    child = 2 * child + 1;
    if (child + 1 < len && c(a[first + child], a[first + child + 1])) ++child;
  } while (!c(a[first + child], top));
  a[first + start] = top;
}

function floydSiftDown<T>(
  a: T[],
  first: number,
  c: Comp<T>,
  len: number
): number {
  let hole = first;
  let childI = first;
  let child = 0;
  for (;;) {
    childI += child + 1;
    child = 2 * child + 1;
    if (child + 1 < len && c(a[childI], a[childI + 1])) {
      ++childI;
      ++child;
    }
    a[hole] = a[childI];
    hole = childI;
    if (child > Math.trunc((len - 2) / 2)) return hole;
  }
}

function siftUp<T>(
  a: T[],
  first: number,
  last: number,
  c: Comp<T>,
  len: number
): void {
  if (len > 1) {
    len = Math.trunc((len - 2) / 2);
    let ptr = first + len;
    if (c(a[ptr], a[--last])) {
      const t = a[last];
      do {
        a[last] = a[ptr];
        last = ptr;
        if (len === 0) break;
        len = Math.trunc((len - 1) / 2);
        ptr = first + len;
      } while (c(a[ptr], t));
      a[last] = t;
    }
  }
}

function popHeap<T>(
  a: T[],
  first: number,
  last: number,
  c: Comp<T>,
  len: number
): void {
  if (len > 1) {
    const top = a[first];
    let hole = floydSiftDown(a, first, c, len);
    --last;
    if (hole === last) {
      a[hole] = top;
    } else {
      a[hole] = a[last];
      ++hole;
      a[last] = top;
      siftUp(a, first, hole, c, hole - first);
    }
  }
}

/** __partial_sort(first, last, last): heap sort of the whole range. */
function heapSort<T>(a: T[], first: number, last: number, c: Comp<T>): void {
  if (first === last) return;
  const n = last - first;
  if (n > 1) {
    for (let start = Math.trunc((n - 2) / 2); start >= 0; --start)
      siftDown(a, first, c, n, start);
  }
  for (let m = n; m > 1; --last, --m) popHeap(a, first, last, c, m);
}

function introsort<T>(
  a: T[],
  first: number,
  last: number,
  c: Comp<T>,
  depth: number,
  leftmost = true
): void {
  const limit = 24;
  const nintherThreshold = 128;
  for (;;) {
    const len = last - first;
    switch (len) {
      case 0:
      case 1:
        return;
      case 2:
        if (c(a[last - 1], a[first])) swap(a, first, last - 1);
        return;
      case 3:
        sort3(a, first, first + 1, last - 1, c);
        return;
      case 4:
        sort4(a, first, first + 1, first + 2, last - 1, c);
        return;
      case 5:
        sort5(a, first, first + 1, first + 2, first + 3, last - 1, c);
        return;
    }
    if (len < limit) {
      if (leftmost) insertionSort(a, first, last, c);
      else insertionSortUnguarded(a, first, last, c);
      return;
    }
    if (depth === 0) {
      heapSort(a, first, last, c);
      return;
    }
    --depth;
    const half = Math.trunc(len / 2);
    if (len > nintherThreshold) {
      sort3(a, first, first + half, last - 1, c);
      sort3(a, first + 1, first + (half - 1), last - 2, c);
      sort3(a, first + 2, first + (half + 1), last - 3, c);
      sort3(a, first + (half - 1), first + half, first + (half + 1), c);
      swap(a, first, first + half);
    } else {
      sort3(a, first + half, first, last - 1, c);
    }
    if (!leftmost && !c(a[first - 1], a[first])) {
      first = partitionWithEqualsOnLeft(a, first, last, c);
      continue;
    }
    const [i, alreadyPartitioned] = partitionWithEqualsOnRight(
      a,
      first,
      last,
      c
    );
    if (alreadyPartitioned) {
      const fs = insertionSortIncomplete(a, first, i, c);
      if (insertionSortIncomplete(a, i + 1, last, c)) {
        if (fs) return;
        last = i;
        continue;
      } else if (fs) {
        first = i + 1;
        continue;
      }
    }
    introsort(a, first, i, c, depth, leftmost);
    leftmost = false;
    first = i + 1;
  }
}

/** std::sort(a.begin(), a.end(), comp), as libc++ 19.1.2 permutes equal elements. */
export function cxxSort<T>(a: T[], comp: (x: T, y: T) => boolean): void {
  const n = a.length;
  if (n === 0) return;
  introsort(a, 0, n, comp, 2 * (31 - Math.clz32(n)));
}

/** std::partial_sort(begin, end, end, comp): introsort's heap-sort fallback (for tests). */
export function cxxHeapSort<T>(a: T[], comp: (x: T, y: T) => boolean): void {
  heapSort(a, 0, a.length, comp);
}
