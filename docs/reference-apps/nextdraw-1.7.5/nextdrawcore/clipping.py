''' hidden line hiding '''

from abc import ABC, abstractmethod
from copy import copy
from enum import Enum
import logging

import pyclipper

from nextdrawcore.path_objects import FillRule

from nextdrawcore.plot_utils_import import from_dependency_import  # plotink
plot_utils = from_dependency_import('plotink.plot_utils')
rtree = from_dependency_import('plotink.rtree')

print_warnings = False  # set to True to see warnings printed


class DeduplicateMessages(logging.Filter):
    def __init__(self):
        self.cache = set()

    def filter(self, log_record):
        if log_record.getMessage() in self.cache:
            return 0  # message already emitted, do not emit again
        else:
            self.cache.add(log_record.getMessage())
            return 1  # emit message


logger = logging.getLogger(__name__)
logger.setLevel(logging.WARN if print_warnings else logging.ERROR)
logger.addFilter(DeduplicateMessages())


class _SpatialGrid:
    """2D hash grid for fast bbox intersection queries.

    Avoids O(N) linear scans by placing paths into grid cells based on
    their bounding boxes. Queries return only paths whose cells overlap
    the query bbox, then callers refine with exact bbox comparison.
    """

    __slots__ = ('_xmin', '_ymin', '_cell_w', '_cell_h', '_nx', '_ny', '_cells')

    def __init__(self, bboxes):
        """Build grid from a list of (xmin, ymin, xmax, ymax) tuples."""
        if not bboxes:
            self._nx = self._ny = 0
            self._cells = {}
            return

        xmin = min(b[0] for b in bboxes)
        ymin = min(b[1] for b in bboxes)
        xmax = max(b[2] for b in bboxes)
        ymax = max(b[3] for b in bboxes)

        width = max(xmax - xmin, 1)
        height = max(ymax - ymin, 1)
        margin = max(width, height) * 0.001 + 1
        self._xmin = xmin - margin
        self._ymin = ymin - margin

        total_w = width + 2 * margin
        total_h = height + 2 * margin

        dim = max(4, int(len(bboxes) ** 0.5))
        self._nx = dim
        self._ny = dim
        self._cell_w = total_w / dim
        self._cell_h = total_h / dim

        self._cells = {}
        for idx, bbox in enumerate(bboxes):
            self._do_insert(idx, bbox)

    def _cell_range(self, bbox):
        x0 = int((bbox[0] - self._xmin) / self._cell_w)
        y0 = int((bbox[1] - self._ymin) / self._cell_h)
        x1 = int((bbox[2] - self._xmin) / self._cell_w)
        y1 = int((bbox[3] - self._ymin) / self._cell_h)
        nx, ny = self._nx - 1, self._ny - 1
        return (max(0, min(x0, nx)), max(0, min(y0, ny)),
                max(0, min(x1, nx)), max(0, min(y1, ny)))

    def _do_insert(self, idx, bbox):
        x0, y0, x1, y1 = self._cell_range(bbox)
        ny = self._ny
        cells = self._cells
        for cx in range(x0, x1 + 1):
            base = cx * ny
            for cy in range(y0, y1 + 1):
                key = base + cy
                cell = cells.get(key)
                if cell is not None:
                    cell.add(idx)
                else:
                    cells[key] = {idx}

    def insert(self, idx, bbox):
        if self._nx > 0:
            self._do_insert(idx, bbox)

    def remove(self, idx, bbox):
        if self._nx == 0:
            return
        x0, y0, x1, y1 = self._cell_range(bbox)
        ny = self._ny
        cells = self._cells
        for cx in range(x0, x1 + 1):
            base = cx * ny
            for cy in range(y0, y1 + 1):
                key = base + cy
                cell = cells.get(key)
                if cell is not None:
                    cell.discard(idx)

    def query(self, bbox):
        if self._nx == 0:
            return set()
        x0, y0, x1, y1 = self._cell_range(bbox)
        result = set()
        ny = self._ny
        cells = self._cells
        for cx in range(x0, x1 + 1):
            base = cx * ny
            for cy in range(y0, y1 + 1):
                key = base + cy
                cell = cells.get(key)
                if cell is not None:
                    result.update(cell)
        return result


class ClipPathsProcess:
    ''' NOTE: does not preserve the direction of the strokes '''

    def __init__(self, clipping_path_cls=None):
        # clipping_path_cls is a class that subclasses AbstractClippingPathItem
        if clipping_path_cls is None:
            clipping_path_cls = _ClippingPathItem_pyclipper

        self.clipping_path_cls = clipping_path_cls

    def run(self, layers, bounds=None, clip_on=True):
        '''
        layers: a list of layers, ordered bottom to top
        bounds: [[x_min, y_min], [x_max, y_max]]  (a rectangle)
        clip_on: if True, perform clipping; else pass through and do nothing

        input paths can have any number of subpaths;
        the output paths can also have any number of subpaths, including unfilled paths

        input paths can be both filled and stroked; output paths may be only filled or stroked
        '''
        paths, layer_dict = self._extract_paths(layers)

        if clip_on:
            paths = self.clip(paths)
            # ANTI-FRAGMENTATION: After clipping, flatten non-filled multi-subpath paths
            # back into separate path objects. This preserves the expected behavior where
            # non-filled path fragments are separate objects (for item_id tracking, etc.)
            # while preventing exponential growth during the clipping process itself.
            paths = self._flatten_nonfilled_paths(paths)

        if bounds is not None:
            # clip using the boundary
            paths = self.clipping_path_cls.from_bounds(bounds).clip_many(paths)
            paths = self._flatten_nonfilled_paths(paths)

        return self._reconstruct_layers(paths, layer_dict, layers)

    @staticmethod
    def clip(paths):
        ''' paths are AbstractClippingPathItems '''
        if len(paths) <= 1:
            return list(paths)

        # For large path counts, the spatial grid + append-only
        # approach is dramatically faster (O(N·M) vs O(N²)).
        # For small counts, the original list-based approach is
        # faster because prefix stays compact and avoids grid overhead.
        if len(paths) >= 500:
            return ClipPathsProcess._clip_with_grid(paths)
        return ClipPathsProcess._clip_linear(paths)

    @staticmethod
    def _clip_linear(paths):
        '''Original list-based algorithm with prefix replacement.
        O(N²) scan but efficient for small path counts where the
        prefix stays compact and grid overhead is not justified.'''
        clipped_paths = list(paths)

        bbox_cache = {}
        for p in clipped_paths:
            bbox_cache[id(p)] = p.calculate_bbox()

        i = 1
        while i < len(clipped_paths):
            if clipped_paths[i].is_filled:
                clipper = clipped_paths[i]
                clipper_bbox = bbox_cache.get(id(clipper))
                if clipper_bbox is None:
                    clipper_bbox = clipper.calculate_bbox()

                intersecting_path_ids = set()
                for j in range(i):
                    cb = bbox_cache.get(id(clipped_paths[j]))
                    if cb is None:
                        cb = clipped_paths[j].calculate_bbox()
                        bbox_cache[id(clipped_paths[j])] = cb
                    if not (clipper_bbox[2] < cb[0] or cb[2] < clipper_bbox[0]
                            or clipper_bbox[3] < cb[1]
                            or cb[3] < clipper_bbox[1]):
                        intersecting_path_ids.add(j)

                if not intersecting_path_ids:
                    i += 1
                    continue

                returned_paths = clipper.clip_many(
                    clipped_paths[:i],
                    intersecting_path_ids=intersecting_path_ids)

                # Always recompute bboxes for returned paths. Python can
                # reuse memory addresses (id()) of freed objects, so a new
                # clip result may share an id with a previously cached path.
                for p in returned_paths:
                    bbox_cache[id(p)] = p.calculate_bbox()

                clipped_paths[:i] = returned_paths
                i = len(returned_paths)
            i += 1
        return clipped_paths

    @staticmethod
    def _clip_with_grid(paths):
        '''Append-only path list with spatial grid for O(N·M)
        performance. Paths are never removed from the list; a "live"
        set tracks which are still active. The grid provides fast
        spatial queries, eliminating the O(N) linear scan per fill.'''
        all_paths = list(paths)
        n_original = len(all_paths)

        # z_rank: original paths get rank = index. Clipped results
        # inherit min parent rank (safe because fills are processed
        # in ascending order — no future fill has intermediate rank).
        z_rank = list(range(n_original))

        live = set(range(n_original))

        bbox_cache = [p.calculate_bbox() for p in all_paths]

        grid = _SpatialGrid(bbox_cache)

        for i in range(1, n_original):
            if i not in live or not all_paths[i].is_filled:
                continue

            clipper_bbox = bbox_cache[i]
            my_rank = z_rank[i]

            candidates = grid.query(clipper_bbox)

            intersecting_indices = []
            for j in candidates:
                if j == i or j not in live:
                    continue
                if z_rank[j] >= my_rank:
                    continue
                cb = bbox_cache[j]
                if not (clipper_bbox[2] < cb[0] or cb[2] < clipper_bbox[0]
                        or clipper_bbox[3] < cb[1]
                        or cb[3] < clipper_bbox[1]):
                    intersecting_indices.append(j)

            if not intersecting_indices:
                continue

            # Only pass intersecting paths — skip non-intersecting pass-through
            intersecting_paths = [all_paths[j] for j in intersecting_indices]
            all_ids = set(range(len(intersecting_paths)))
            clipped_results = all_paths[i].clip_many(
                intersecting_paths, intersecting_path_ids=all_ids)

            min_rank = min(z_rank[j] for j in intersecting_indices)
            for j in intersecting_indices:
                live.discard(j)
                grid.remove(j, bbox_cache[j])

            for result in clipped_results:
                new_idx = len(all_paths)
                all_paths.append(result)
                z_rank.append(min_rank)
                live.add(new_idx)
                bbox = result.calculate_bbox()
                bbox_cache.append(bbox)
                grid.insert(new_idx, bbox)

        # Collect results in z-order
        live_list = sorted(live, key=lambda idx: (z_rank[idx], idx))
        return [all_paths[idx] for idx in live_list]

    @staticmethod
    def calculate_bounds(physical_bounds, svg_height, svg_width,
                         clip_to_page=False, rotate_page=False):
        '''
        physical_bounds: [[x_min, y_min], [x_max, y_max]]  (a rectangle)

        returns bounds in the same format, considering the flags
            `clip_to_page`, `rotate_page` and the svg bounds
            (which are inflated by some small amt)
        '''
        if rotate_page:
            doc_bounds = [svg_height + 1e-9, svg_width + 1e-9]
        else:
            doc_bounds = [svg_width + 1e-9, svg_height + 1e-9]

        bounds = copy(physical_bounds)
        if clip_to_page:  # clip to svg/doc bounds
            bounds[1][0] = min(doc_bounds[0], bounds[1][0])  # x maximum
            bounds[1][1] = min(doc_bounds[1], bounds[1][1])  # y maximum
        return bounds

    def check_warn_bounds(self, phy_bounds, warn_tol):
        '''
        Not implemented. Checks for certain user warnings, but doing so in all cases
            is more complex to implement than seems justified, and gives a user experience
            that seems more complex than reasonable.

        How to implement:
        offset/expand phy_bounds by warn_tol;
        use pyclipper to find difference between phy_bounds & paths;
        if any point has positive numbers, return true; else false '''

    def _extract_paths(self, layers):
        ''' given a list of layers, return a 1-D list of AbstractClippingPathItem '''
        paths = []
        layer_dict = {}
        for layer in layers:
            layer_dict[layer.item_id] = []
            layer_paths = [self.clipping_path_cls.from_path_item(path, layer.item_id)
                           for path in layer.paths]
            paths.extend(layer_paths)

        paths = filter(lambda p: p is not None, paths)

        paths = self._flatten_nonfilled_paths(paths)

        return paths, layer_dict

    @staticmethod
    def _reconstruct_layers(paths, layer_dict, layers):
        # reconstruct layers for returning to caller
        path_id_counts = {}

        for path in paths:
            if path.layer_id in layer_dict:
                if path.path_item.item_id in path_id_counts:
                    path_id_counts[path.path_item.item_id] += 1
                else:
                    path_id_counts[path.path_item.item_id] = 1

                layer_dict[path.layer_id].append(
                    path.to_path_item(path_id_counts[path.path_item.item_id]))
        for layer in layers:
            layer.paths = layer_dict[layer.item_id]

        return layers

    @staticmethod
    def _flatten_nonfilled_paths(paths):
        ''' in certain cases, flattening paths drastically decreases run time.
        Filled paths cannot be flattened without losing information about non-simply
        connected regions, but nonfilled paths can be.'''
        new_paths = []
        for path in paths:
            if path.is_filled:  # cannot be flattened
                new_paths.append(path)
                continue

            if len(path.subpaths) == 1:
                new_paths.append(path)
                continue

            for subpath in path.subpaths:
                new_path = _ClippingPathItem_pyclipper.from_cpath(
                    path, [subpath], is_stroked=path.is_stroked, is_filled=False)
                new_paths.append(new_path)

        return new_paths


class AbstractClippingPathItem(ABC):
    ''' subclass this for use with ClipPathsProcess '''

    @abstractmethod
    def clip_many(self, clippees):
        ''' This is the meat of the clipping.
        clip clippees using self as clipping path.
        return a list of self.__class__ '''
        raise NotImplementedError()

    # The following methods are all about converting between
    # PathItem and the AbstractClippingPathItem subclass

    @classmethod
    @abstractmethod
    def from_path_item(cls, path_item, layer_id):
        ''' return an object of this class converted from a PathItem '''
        raise NotImplementedError()

    @classmethod
    @abstractmethod
    def from_bounds(cls, bounds):
        ''' return an object of this class converted from the bounds of the drawing space
        bounds = [[x_min, y_min], [x_max, y_max]]  (a rectangle)'''
        raise NotImplementedError()

    @classmethod
    @abstractmethod
    def to_path_item(self):
        ''' return an equivalent PathItem object; all PathItem.item_id should be unique '''
        raise NotImplementedError()


class _ClippingPathItem_pyclipper(AbstractClippingPathItem):
    ''' An implementation of AbstractClippingPathItem for use with pyclipper '''
    fill_rule_map = {
        None: pyclipper.PFT_NONZERO,  # default
        FillRule.NONZERO: pyclipper.PFT_NONZERO,
        "nonzero": pyclipper.PFT_NONZERO,
        FillRule.EVENODD: pyclipper.PFT_EVENODD,
        "evenodd": pyclipper.PFT_EVENODD,
    }

    def __init__(self, path_item, layer_id, subpaths, is_stroked, is_filled, **kwargs):
        '''Do not use this constructor directly.
        Use the cls.from_* methods'''
        self.path_item = path_item
        self.layer_id = layer_id
        self.subpaths = subpaths
        self.is_stroked = is_stroked
        self.is_filled = is_filled

        self.clip_op = kwargs.pop('clip_op', pyclipper.CT_DIFFERENCE)

        fill_rule = kwargs.pop('fill_rule', pyclipper.PFT_NONZERO)
        if self.is_filled:
            self.fill_rule = fill_rule

        self.adjust_horizontal_segments()

        assert len(kwargs.keys()) == 0

    def adjust_horizontal_segments(self):
        ''' We've encountered a couple of very odd bugs, where clipper/pyclipper doesn't
        handle horizontal line segments very well. '''
        # naive implementation
        X = 0
        Y = 1

        epsilon = 1
        for subpath in self.subpaths:
            i = 1
            while i < len(subpath):
                if subpath[i][Y] == subpath[i - 1][Y]:  # y coords are equal
                    subpath[i] = (subpath[i][X], subpath[i]
                                  [Y] + epsilon)  # bump y
                    epsilon *= -1  # flip epsilon sign to avoid accumulation
                i += 1

    def calculate_bbox(self, subpath_index=None):
        '''Calculate and return bounding box as (xmin, ymin, xmax, ymax) in clipper space

        Args:
            subpath_index: If provided, calculate bbox for only that subpath.
                          If None, calculate bbox for all subpaths combined.
        '''
        if not self.subpaths:
            return (0, 0, 0, 0)

        # If specific subpath requested, only process that one
        if subpath_index is not None:
            subpaths_to_process = (self.subpaths[subpath_index],)
        else:
            subpaths_to_process = self.subpaths

        # Initialize with first point
        first_subpath = subpaths_to_process[0]
        if not first_subpath:
            return (0, 0, 0, 0)

        first_point = first_subpath[0]
        xmin = xmax = first_point[0]
        ymin = ymax = first_point[1]

        # Find min/max across specified subpaths (optimized with direct comparison)
        for subpath in subpaths_to_process:
            for point in subpath:
                x, y = point[0], point[1]
                if x < xmin:
                    xmin = x
                elif x > xmax:
                    xmax = x
                if y < ymin:
                    ymin = y
                elif y > ymax:
                    ymax = y

        return (xmin, ymin, xmax, ymax)

    @staticmethod
    def bboxes_intersect(bbox1, bbox2):
        '''Check if two bounding boxes intersect'''
        x1_min, y1_min, x1_max, y1_max = bbox1
        x2_min, y2_min, x2_max, y2_max = bbox2

        # Check for disjoint boxes (separate if statements for early return)
        if x1_max < x2_min or x2_max < x1_min:
            return False
        if y1_max < y2_min or y2_max < y1_min:
            return False

        return True

    def are_subpaths_independent(self):
        '''Check if clipper subpaths can be processed independently.

        For per-subpath clipping to be safe, we need to avoid non-simply connected
        regions created by counter-wound holes. However, overlapping same-wound regions
        (like overlapping circles) are fine to process per-subpath.

        Conservative heuristic: Allow per-subpath clipping unless we detect potential
        holes. Since we can't easily check winding without expensive geometry operations,
        we use a simple rule: if there are "too many" overlapping bboxes, it might be
        a complex shape with holes, so fall back to all-subpaths approach.
        '''
        if len(self.subpaths) <= 1:
            return True  # Single or no subpaths are trivially independent

        # Calculate bbox for each subpath
        bboxes = [self.calculate_bbox(i) for i in range(len(self.subpaths))]

        # Count how many bbox pairs overlap
        overlap_count = 0
        for i in range(len(bboxes)):
            for j in range(i + 1, len(bboxes)):
                if self.bboxes_intersect(bboxes[i], bboxes[j]):
                    overlap_count += 1

        # Heuristic: If less than 5% of possible pairs overlap, likely independent shapes
        # If more, might be complex nested structure, use conservative approach
        total_pairs = (len(bboxes) * (len(bboxes) - 1)) / 2
        overlap_ratio = overlap_count / total_pairs if total_pairs > 0 else 0

        threshold = 0.05  # 5% overlap threshold
        is_independent = overlap_ratio < threshold

        return is_independent

    def create_single_subpath_clipper(self, subpath_idx):
        '''Create a new clipper containing only the specified subpath'''
        return self.__class__.from_cpath(
            self,
            [self.subpaths[subpath_idx]],
            is_stroked=False,
            is_filled=True
        )

    @classmethod
    def from_path_item(cls, path_item, layer_id):
        ''' path_item = an item of class PathItem. '''
        assert layer_id is not False
        fill_rule = cls.fill_rule_map[path_item.fill_rule] if path_item.fill else None

        try:
            subpaths = pyclipper.scale_to_clipper(path_item.subpaths)
        except OverflowError:
            logger.warning(
                "(warning) A path was too large to compute. Path was not printed.")
            return None

        is_filled = str(path_item.fill).lower() != "none"

        return cls(
            path_item, layer_id, subpaths,
            is_filled=is_filled, is_stroked=path_item.has_stroke(),
            fill_rule=fill_rule)

    @classmethod
    def from_cpath(cls, cpath, subpaths, is_stroked, is_filled):
        ''' create a new ClippingPathItem_pyclipper based on
        another ClippingPathItem_pyclipper (param `cpath`) '''
        return cls(
            copy(cpath.path_item), cpath.layer_id, subpaths,
            is_stroked, is_filled)

    @classmethod
    def from_bounds(cls, bounds):
        ''' bounds = [[x_min, y_min], [x_max, y_max]]  (a rectangle)'''
        (x_min, y_min), (x_max, y_max) = bounds

        def rectangle_path(x_min, y_min, x_max, y_max):
            return [(x_min, y_min), (x_max, y_min), (x_max, y_max), (x_min, y_max), (x_min, y_min)]

        bounds = rectangle_path(x_min, y_min, x_max, y_max)
        subpaths = [pyclipper.scale_to_clipper(bounds)]
        return cls(
            path_item="bounds", layer_id=False, subpaths=subpaths,
            is_stroked=False, is_filled=True,
            clip_op=pyclipper.CT_INTERSECTION)

    def to_path_item(self, item_id_count=1):
        ''' return an equivalent PathItem object '''
        if self.layer_id is False:
            return None
        path_item = copy(self.path_item)
        path_item.subpaths = pyclipper.scale_from_clipper(self.subpaths)
        path_item.fill = self.path_item.fill if self.is_filled else None
        path_item.fill_rule = self.path_item.fill_rule if self.is_filled else None
        path_item.stroke = self.path_item.stroke if self.is_stroked else None

        # use item_id_count to generate unique item_id's
        if item_id_count == 1:
            path_item.item_id = self.path_item.item_id
        else:
            path_item.item_id = "{}_{}".format(
                self.path_item.item_id, item_id_count)

        return path_item

    def clip_many(self, clippees, intersecting_path_ids=None):
        ''' clip clippees using self as clipping path. return a list of paths

        intersecting_path_ids: optional pre-computed set of clippee indices
            whose bboxes intersect the clipper's bbox. When provided (from
            ClipPathsProcess.clip's persistent bbox cache), skips the per-call
            search for intersecting clippees.
        '''
        if not clippees:
            return []

        # Check if we can use per-subpath optimization
        # This is safe when clipper subpaths are independent (e.g., separate circles)
        # but not when they form non-simply connected regions (e.g., shapes with holes)
        if len(self.subpaths) > 1 and self.are_subpaths_independent():
            return self._clip_many_per_subpath(clippees)
        else:
            return self._clip_many_all_subpaths(clippees, intersecting_path_ids)

    def _clip_many_all_subpaths(self, clippees, intersecting_path_ids=None):
        '''Clip by all clipper subpaths at once (original approach).

        Used for single-subpath clippers or when subpaths overlap (potential holes).

        intersecting_path_ids: optional pre-computed set of clippee indices
            whose bboxes intersect the clipper. When provided, skips the
            search for intersecting clippees.
        '''
        if intersecting_path_ids is None:
            # No pre-computed data: find clippees that meet the clipping path
            intersecting_path_ids = self._find_intersecting_clippees(clippees)

        results = []

        # Process paths in original order to preserve ordering
        for i, clippee in enumerate(clippees):
            if i in intersecting_path_ids:
                # Clip intersecting paths
                results.extend(self.clip_filled(clippee) if clippee.is_filled
                               else [])
                results.extend(self.clip_stroked(clippee) if clippee.is_stroked
                               else [])
            else:
                # Non-intersecting paths: behavior depends on clip operation
                # CT_DIFFERENCE (hidden line removal): preserve path unchanged
                # CT_INTERSECTION (bounds clipping): discard path (nothing in common)
                if self.clip_op == pyclipper.CT_DIFFERENCE:
                    if clippee.is_filled and clippee.is_stroked:
                        # Split into separate filled-only and stroked-only items,
                        # consistent with how intersecting paths are split above.
                        results.append(self.from_cpath(
                            clippee, clippee.subpaths,
                            is_stroked=False, is_filled=True))
                        results.append(self.from_cpath(
                            clippee, clippee.subpaths,
                            is_stroked=True, is_filled=False))
                    else:
                        results.append(clippee)
                # else: CT_INTERSECTION - discard non-intersecting paths

        for result in results:
            assert not (result.is_filled and result.is_stroked), result
        return results

    def _find_intersecting_clippees(self, clippees):
        '''Return the set of indices of clippees with a subpath whose bbox meets
        the bbox of any of this path's subpaths.

        Used when no pre-computed intersection data is available (e.g., bounds
        clipping). The persistent bbox cache in clip() makes this unnecessary
        for the main hidden-line-removal loop. The clipper has only a few
        subpaths, so a direct comparison against each clippee subpath is used.
        '''
        clipper_bboxes = [self.calculate_bbox(i)
                          for i in range(len(self.subpaths)) if self.subpaths[i]]

        intersecting_path_ids = set()
        for path_idx, clippee in enumerate(clippees):
            for subpath_idx in range(len(clippee.subpaths)):
                if not clippee.subpaths[subpath_idx]:
                    continue
                xmin, ymin, xmax, ymax = clippee.calculate_bbox(subpath_idx)
                if any(not (x_1 > xmax or y_1 > ymax or x_2 < xmin or y_2 < ymin)
                       for (x_1, y_1, x_2, y_2) in clipper_bboxes):
                    intersecting_path_ids.add(path_idx)
                    break
        return intersecting_path_ids

    def _clip_many_per_subpath(self, clippees):
        '''Clip by each clipper subpath separately (optimized approach).

        Used when clipper subpaths are independent (don't overlap). This dramatically
        reduces pyclipper work by only sending intersecting geometry to the clipper.

        For example, with 171 non-overlapping circles clipping 2344 lines where each
        line only intersects 1-2 circles, this reduces geometric operations from
        ~284,000 to ~1,200 (200x speedup potential).
        '''
        # Build spatial index of clippee subpaths once
        subpath_id = 0
        id_to_path_idx = {}
        spatial_index_data = []

        for path_idx, clippee in enumerate(clippees):
            for subpath_idx in range(len(clippee.subpaths)):
                # Skip empty subpaths (no geometry to index)
                if not clippee.subpaths[subpath_idx]:
                    continue

                bbox = clippee.calculate_bbox(subpath_idx)
                spatial_index_data.append((subpath_id, bbox))
                id_to_path_idx[subpath_id] = path_idx
                subpath_id += 1

        spatial_index = rtree.Index(spatial_index_data)

        # Track clippees and their clipped results
        # Start with all clippees, update as they get clipped
        clippee_map = {i: clippee for i, clippee in enumerate(clippees)}

        total_clipped_count = 0
        total_skipped_count = 0
        next_split_id = -1  # Monotonic counter for split-path IDs

        # Process each clipper subpath separately
        for clipper_subpath_idx, _ in enumerate(self.subpaths):
            # Skip empty clipper subpaths
            if not self.subpaths[clipper_subpath_idx]:
                continue

            clipper_subpath_bbox = self.calculate_bbox(clipper_subpath_idx)
            intersecting_subpath_ids = spatial_index.intersection(
                clipper_subpath_bbox)

            # Get unique path indices that intersect this clipper subpath
            if not intersecting_subpath_ids:
                continue  # No overlap with this clipper subpath
            intersecting_path_ids = {
                id_to_path_idx[sid] for sid in intersecting_subpath_ids}

            total_clipped_count += len(intersecting_path_ids)
            total_skipped_count += len(clippee_map) - \
                len(intersecting_path_ids)

            # Create single-subpath clipper for this subpath only
            single_clipper = self.create_single_subpath_clipper(
                clipper_subpath_idx)

            # Clip only the intersecting paths by this single subpath
            new_clippee_map = {}
            for clippee_id in intersecting_path_ids:
                if clippee_id not in clippee_map:
                    continue  # Already fully clipped by previous subpath

                clippee = clippee_map[clippee_id]

                # Collect clipped results (avoid empty list creation if not needed)
                clipped_results = []
                if clippee.is_filled:
                    clipped_results = single_clipper.clip_filled(clippee)
                if clippee.is_stroked:
                    stroked_results = single_clipper.clip_stroked(clippee)
                    if clipped_results:
                        clipped_results.extend(stroked_results)
                    else:
                        clipped_results = stroked_results

                # Update the clippee with clipped result(s)
                # Note: clipping can produce multiple result paths or none (fully clipped)
                num_results = len(clipped_results)
                if num_results == 1:
                    new_clippee_map[clippee_id] = clipped_results[0]
                elif num_results > 1:
                    # Multiple results - keep first, add rest with new IDs
                    new_clippee_map[clippee_id] = clipped_results[0]
                    # For additional pieces, add with unique negative IDs
                    for extra_result in clipped_results[1:]:
                        new_clippee_map[next_split_id] = extra_result
                        next_split_id -= 1
                # else: num_results == 0, path was fully removed

            # Update clippee_map with clipped results
            for clippee_id in intersecting_path_ids:
                if clippee_id in new_clippee_map:
                    clippee_map[clippee_id] = new_clippee_map[clippee_id]
                else:
                    # Fully clipped, remove from map
                    if clippee_id in clippee_map:
                        del clippee_map[clippee_id]

            # Add any new split results
            for clippee_id, clippee in new_clippee_map.items():
                if clippee_id < 0:  # New split result
                    clippee_map[clippee_id] = clippee

        # Debug logging (disabled by default)
        if False:  # Set to True to see per-subpath statistics
            avg_clipped = total_clipped_count / \
                len(self.subpaths) if len(self.subpaths) > 0 else 0
            avg_skipped = total_skipped_count / \
                len(self.subpaths) if len(self.subpaths) > 0 else 0
            print(f"[PER-SUBPATH] {len(self.subpaths)} clipper subpaths (independent). "
                  f"Avg per subpath: {avg_clipped:.1f} clipped, {avg_skipped:.1f} skipped "
                  f"({avg_skipped*100.0/(avg_clipped+avg_skipped):.1f}% skipped per subpath)")

        # Return results in original path order (positive indices first, sorted)
        # Negative indices are for split paths, append them after
        positive_ids = sorted([k for k in clippee_map.keys() if k >= 0])
        negative_ids = sorted([k for k in clippee_map.keys() if k < 0])
        results = []
        for i in positive_ids + negative_ids:
            clippee = clippee_map[i]
            if clippee.is_filled and clippee.is_stroked:
                # Non-intersecting path that was never clipped; split into
                # separate filled-only and stroked-only items.
                results.append(self.from_cpath(
                    clippee, clippee.subpaths,
                    is_stroked=False, is_filled=True))
                results.append(self.from_cpath(
                    clippee, clippee.subpaths,
                    is_stroked=True, is_filled=False))
            else:
                results.append(clippee)

        for result in results:
            assert not (result.is_filled and result.is_stroked), result
        return results

    def clip_filled(self, clippee):
        ''' used when clippee is filled '''
        return self.clip(clippee, PathType.FILL, self._complete_the_loop)

    def clip_stroked(self, clippee):
        ''' used when clippee is stroked '''
        results = self.clip(clippee, PathType.STROKE, self._rejoin)
        return results

    def clip(self, clippee, path_type, postclip_process):
        '''
        `path_type` is PathType.FILL or PathType.STROKE
        `postclip_process` is a function that takes & returns a list of points
        '''
        assert path_type in list(PathType)
        # use a dummy fill rule if clippee is not filled
        clippee_fill_rule = clippee.fill_rule if clippee.is_filled else pyclipper.PFT_NONZERO

        results = self._use_pyclipper_to_clip(
            clippee, clippee_fill_rule, path_type)
        results = postclip_process(results)

        # ANTI-FRAGMENTATION FIX: Always group all clipping results into a single
        # multi-subpath path object, regardless of input subpath count. This prevents
        # exponential fragmentation growth when paths are repeatedly clipped.
        #
        # Without this, clipping operations create separate path objects for each
        # fragment, causing exponential growth: 10 → 20 → 40 → 80 → 2048 paths.
        # With this, we maintain ~constant path count throughout clipping pipeline.
        if len(results) == 0:
            return []

        return [self.__class__.from_cpath(clippee, results,
                                          path_type == PathType.STROKE,
                                          path_type == PathType.FILL)]

    def _use_pyclipper_to_clip(self, clippee, clippee_fill_rule, path_type):
        try:
            pclip = pyclipper.Pyclipper()

            # pyclipper requires clippers to be "closed", so we use
            # closed=True, even for open, filled paths
            pclip.AddPaths(self.subpaths, pyclipper.PT_CLIP, closed=True)
            pclip.AddPaths(clippee.subpaths, pyclipper.PT_SUBJECT,
                           closed=(path_type == PathType.FILL))

            results = pclip.Execute2(
                self.clip_op, clippee_fill_rule, self.fill_rule)
            results = pyclipper.PolyTreeToPaths(results)
            return results
        except pyclipper._pyclipper.ClipperException:
            length_zero = True
            for subpath in clippee.subpaths:
                for point in subpath[1:]:
                    if point != subpath[1]:
                        length_zero = False
                        break
            # pyclipper does not handle paths of length zero
            if not length_zero:
                logger.warning("(warning) Clipping process failed for "
                               "some paths. Skipping those paths.")
            return [sp for sp in clippee.subpaths]

    @staticmethod
    def _complete_the_loop(paths):
        ''' pyclipper returns the closed paths without the last point,
        (which is the same as the first point), but PathItem explicitly states the last point '''
        paths = [pyclipper.CleanPolygon(path) if len(
            path) > 2 else path for path in paths]
        return [path + copy(path[:1]) for path in paths]

    @staticmethod
    def _rejoin(paths):
        ''' if the ends of the paths share a coordinate, mash them together into one path.
        Returns a list. Only for open paths.

        prime candidate for factoring out
        '''
        def join_2(path_a, path_b):
            nonlocal joined
            joined = True
            return path_a + path_b[1:]  # avoid duplicate coordinates

        def almost_equal(a, b):
            # due to horizontal adjusting, Y coordinates may be off by one
            X, Y = 0, 1
            if a[X] != b[X]:
                return False

            if abs(a[Y] - b[Y]) > 1:
                return False

            return True

        i = 0
        while i < len(paths):
            j = i + 1
            while j < len(paths):
                joined = False
                if almost_equal(paths[i][0], paths[j][0]):
                    paths[i].reverse()
                    paths[i] = join_2(paths[i], paths[j])
                elif almost_equal(paths[i][0], paths[j][-1]):
                    paths[i] = join_2(paths[j], paths[i])
                elif almost_equal(paths[i][-1], paths[j][0]):
                    paths[i] = join_2(paths[i], paths[j])
                elif almost_equal(paths[i][-1], paths[j][-1]):
                    paths[j].reverse()
                    paths[i] = join_2(paths[i], paths[j])

                if joined:
                    paths.pop(j)
                else:
                    j += 1
            i += 1
        return paths

    def __repr__(self):
        template = ("\n{}(\n path_item={},\n layer_id={},\n is_filled={},\n is_stroked={},\n " +
                    "subpaths={})")
        return template.format(type(self).__name__, repr(self.path_item), self.layer_id,
                               self.is_filled, self.is_stroked, self.subpaths)

    def __str__(self):
        source = self.path_item.item_id if hasattr(
            self.path_item, "item_id") else self.path_item
        template = ("{}:\n  source: {}\n  layer_id: {}\n  is_stroked: {}\n  " +
                    "is_filled: {}\n  subpaths: {}")
        return template.format(type(self).__name__, source, self.layer_id,
                               self.is_stroked, self.is_filled, self.subpaths)


class PathType(Enum):
    FILL = "fill"
    STROKE = "stroke"
