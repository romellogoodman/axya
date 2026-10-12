// Generator for test/fixtures/clipping-sort-vectors.json: the permutations
// libc++'s std::sort (and std::partial_sort over the whole range, its
// heap-sort fallback) produce for keys with many ties, compared like
// Clipper's LocMinSorter (descending). server/driver/digest/clippingSort.ts
// must reproduce them.
//
// Regenerate (macOS, Apple clang + libc++ 19 or later):
//   clang++ -std=c++17 -O2 -o /tmp/csv test/oracle/clipping_sort_vectors.cpp
//   /tmp/csv > test/fixtures/clipping-sort-vectors.json

#include <algorithm>
#include <cstdio>
#include <map>
#include <random>
#include <vector>

struct Item {
  int key;
  int id;
};
static bool comp(const Item& a, const Item& b) { return b.key < a.key; }

// McIlroy's "A killer adversary for quicksort": builds an input that drives
// std::sort deep enough to reach its heap-sort fallback.
static std::vector<int> killer(int n) {
  std::vector<int> val(n, n);  // n = "gas"
  int nsolid = 0, candidate = 0;
  std::vector<int> ptr(n);
  for (int i = 0; i < n; i++) ptr[i] = i;
  auto freeze = [&](int x) { val[x] = nsolid++; };
  std::sort(ptr.begin(), ptr.end(), [&](int x, int y) {
    if (val[x] == n && val[y] == n) {
      if (x == candidate) freeze(x);
      else freeze(y);
    }
    if (val[x] == n) candidate = x;
    else if (val[y] == n) candidate = y;
    return val[x] < val[y];
  });
  return val;
}

static void emit(const char* kind, const std::vector<int>& keys, bool& firstOut) {
  std::vector<Item> v;
  for (size_t i = 0; i < keys.size(); i++) v.push_back({keys[i], (int)i});
  if (kind[0] == 's') std::sort(v.begin(), v.end(), comp);
  else std::partial_sort(v.begin(), v.end(), v.end(), comp);
  printf("%s\n{\"kind\":\"%s\",\"keys\":[", firstOut ? "" : ",", kind);
  firstOut = false;
  for (size_t i = 0; i < keys.size(); i++) printf("%s%d", i ? "," : "", keys[i]);
  printf("],\"ids\":[");
  for (size_t i = 0; i < v.size(); i++) printf("%s%d", i ? "," : "", v[i].id);
  printf("]}");
}

int main() {
  std::mt19937 rng(12345);
  bool firstOut = true;
  printf("[");
  for (int n = 0; n <= 40; n++) {
    for (int rep = 0; rep < 3; rep++) {
      std::vector<int> k(n);
      int distinct = 1 + rng() % (n + 1);
      for (int& x : k) x = rng() % distinct;
      emit("sort", k, firstOut);
    }
  }
  int sizes[] = {60, 100, 127, 128, 129, 130, 200, 257, 400};
  for (int n : sizes) {
    for (int distinct : {2, 5, 20, 1000}) {
      std::vector<int> k(n);
      for (int& x : k) x = rng() % distinct;
      emit("sort", k, firstOut);
      std::vector<int> s = k;  // presorted runs, both directions
      std::sort(s.begin(), s.end());
      emit("sort", s, firstOut);
      std::reverse(s.begin(), s.end());
      emit("sort", s, firstOut);
    }
  }
  for (int n : {50, 130, 300, 400}) {
    std::vector<int> v = killer(n), k(n);
    for (int i = 0; i < n; i++) k[i] = -v[i];
    emit("sort", k, firstOut);
  }
  for (int n : {0, 1, 2, 3, 7, 24, 31, 100, 257}) {
    std::vector<int> k(n);
    for (int& x : k) x = rng() % 6;
    emit("heap", k, firstOut);
  }
  printf("\n]\n");
}
