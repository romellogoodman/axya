# Copyright 2026 Windell H. Oskay, Bantam Tools
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 2 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program; if not, write to the Free Software
# Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA

"""
plot_status.py

Classes for managing NextDraw plot status

Part of the NextDraw driver software
http://bantamtools.com

"""

import math
import time
from collections import deque
from itertools import islice
# from tqdm import tqdm
from lxml import etree
from nextdrawcore import serial_utils

from nextdrawcore.plot_utils_import import from_dependency_import
text_utils = from_dependency_import('plotink.text_utils')
inkex = from_dependency_import('ink_extensions.inkex')


def parse_dist(dist_str, default_unit):
    """ Parse distance string, return value in inches. """
    s = str(dist_str).strip().lower()

    if s.endswith('mm'):
        return float(s[:-2]) / 25.4
    elif s.endswith('cm'):
        return float(s[:-2]) / 2.54
    elif s.endswith('in'):
        return float(s[:-2])

    # No known unit - check for unknown unit suffix
    if s and s[-1].isalpha():
        raise ValueError(f"Unknown unit in '{dist_str}'")

    # Bare number - use default unit
    if default_unit == 'mm':
        return float(s) / 25.4
    elif default_unit == 'cm':
        return float(s) / 2.54
    else:
        return float(s)


class SVGPlotData:  # pylint: disable=too-few-public-methods, too-many-instance-attributes
    """
    PlotData: Storage class for data items in plotdata elements within the SVG file
    """

    def __init__(self):
        self.application = None
        self.auto_rot = None
        self.handling = None
        self.hiding = None
        self.layer = None
        self.model = None
        self.reordering = None
        self.pause_dist = None
        self.pause_ref = None
        self.pause_warn = None
        self.plob_version = None
        self.rand_seed = None
        self.rand_start = None
        self.reset()  # Set defaults

    def reset(self):
        """ Set or Reset instance attributes to defaults """
        self.application = ""
        self.auto_rot = 0
        self.handling = 0
        self.hiding = 0
        self.layer = -2          # <0 is a flag to *print all layers; -2 indicates default
        self.model = 0
        self.reordering = 0
        self.pause_dist = -1     # <0 is a flag that there is no resume data.
        self.pause_ref = -1      # <0 is a flag that there is no resume data.
        self.pause_warn = 0      # Cleared to zero when pause warning given to user
        self.plob_version = "n/a"
        self.rand_seed = 1
        self.rand_start = 0

    def clean(self):
        """ Clean up settings when a plot finishes normally; indicate no resume needed """
        self.layer = -2         # <0 is a flag to *print all layers; -2 indicates default
        self.pause_dist = -1    # <0 is a flag that there is no resume data.


class ResumeStatus:
    """
    ResumeStatus: Class for managing status items related to pausing
        and resuming plots, including managing plot data stored in SVG file
    """

    def __init__(self):
        self.read = False           # Boolean: Data has been read from SVG file
        self.written = False        # Boolean: Data written to SVG file
        self.old = SVGPlotData()
        self.new = SVGPlotData()
        self.update_needed = False  # If true, we need to update data in the SVG file
        self.button_timestamp = 0   # Timestamp for last button check
        self.drip = DripCache()     # Cache for recent moves, used for managing pause process.
        self.reset()                # Set defaults via reset function

    def reset(self):
        '''Set default values'''
        self.read = False                   # Boolean: Data has been read from SVG file
        self.written = False                # Boolean: Data written to SVG file
        self.update_needed = False          # If true, we need to update data in the SVG file
        self.button_timestamp = time.time()     # Timestamp for last button check
        self.old.reset()
        self.new.reset()
        self.drip.reset()

    def read_from_svg(self, svg_tree):
        """
        Read plot progress data, stored in a custom "plotdata" XML element
        pause_dist, pause_ref stored in file as integer with µm units but used as inch units.
        """
        self.read = False
        data_node = None

        nodes = svg_tree.findall('{https://bantam.tools/nd}plotdata')  # Current version location
        if not nodes:
            nodes = svg_tree.xpath("//*[self::svg:plotdata|self::plotdata]", namespaces=inkex.NSS)
        if nodes:

            data_node = nodes[0]
        if data_node is not None:
            try:  # Core data required for resuming plots
                self.old.application = data_node.get('application')
                self.old.auto_rot = int(data_node.get('auto_rot'))
                self.old.handling = int(data_node.get('handling'))
                self.old.hiding = int(data_node.get('hiding'))
                self.old.layer = int(data_node.get('layer'))
                self.old.model = int(data_node.get('model'))
                self.old.reordering = int(data_node.get('optim'))
                self.old.pause_dist = int(data_node.get('pause_dist')) / 25400
                self.old.pause_ref = int(data_node.get('pause_ref')) / 25400
                self.old.pause_warn = int(data_node.get('pause_warn'))
                self.old.plob_version = data_node.get('plob_version')
                if self.old.plob_version is None:
                    self.old.plob_version = "n/a"
                self.old.rand_seed = int(float(data_node.get('rand_seed')))
                self.old.rand_start = int(data_node.get('rand_start'))
                self.read = True
            except TypeError:  # An error leaves self.read as False.
                try:
                    svg_tree.remove(data_node)  # Remove data node
                except ValueError:  # "Element is not a child of this node."
                    pass            # Well it was nice to try.

    def write_to_svg(self, svg_tree):
        """
        Write plot progress data, stored in a custom "plotdata" XML element
        pause_dist, pause_ref stored as integer with µm units
        """
        if not self.written:
            for node in svg_tree.iterfind('{https://bantam.tools/nd}plotdata'):
                node.getparent().remove(node)
            for node in svg_tree.iterfind('{http://www.w3.org/2000/svg}plotdata'):
                node.getparent().remove(node)
            data_node = etree.SubElement(svg_tree,
                                         etree.QName('https://bantam.tools/nd', 'plotdata'))
            if self.new.application == "":
                self.new.application = "nextdraw"  # Name of this program
            data_node.set('application', self.new.application)
            data_node.set('auto_rot', str(self.new.auto_rot))
            data_node.set('handling', str(self.new.handling))
            data_node.set('hiding', str(self.new.hiding))
            data_node.set('layer', str(self.new.layer))
            data_node.set('model', str(self.new.model))
            data_node.set('optim', str(self.new.reordering))
            data_node.set('pause_dist', f"{round(self.new.pause_dist * 25400)}")  # units µm
            data_node.set('pause_ref',  f"{round(self.new.pause_ref * 25400)}")  # units µm
            data_node.set('pause_warn', str(self.new.pause_warn))
            data_node.set('plob_version', str(self.new.plob_version))
            data_node.set('rand_seed', f"{self.new.rand_seed}")
            data_node.set('rand_start', str(self.new.rand_start))
            self.written = True

    def copy_old(self):
        """ Copy old attributes to new """
        self.new.application = self.old.application
        self.new.auto_rot = self.old.auto_rot
        self.new.handling = self.old.handling
        self.new.hiding = self.old.hiding
        self.new.layer = self.old.layer
        self.new.model = self.old.model
        self.new.reordering = self.old.reordering
        self.new.pause_dist = self.old.pause_dist
        self.new.pause_ref = self.old.pause_ref
        self.new.pause_warn = self.old.pause_warn
        self.new.plob_version = self.old.plob_version
        self.new.rand_seed = self.old.rand_seed
        self.new.rand_start = self.old.rand_start

    def check_button(self, nd_ref):
        """
        Check for button press, if not preview, and not too soon after last check.
        Return: 1 if button pressed, 0 if not (or if we did not check), and -1 in case of error.
        """

        # Uncomment next two lines to force a pause at a specific position
        # if nd_ref.options.mode == "plot" and nd_ref.plot_status.stats.down_travel_inch >= 2350.1:
            # return 1

        if nd_ref.options.preview:
            return 0

        time_now = time.time()
        if (time_now - self.button_timestamp) > nd_ref.params.button_interval:
            self.button_timestamp = time_now
            serial_utils.read_status_byte(nd_ref)
        if nd_ref.plot_status.button:
            return 1
        if nd_ref.plot_status.connection:
            return -1
        return 0

    def manage_offset(self, nd_ref):
        """ Read and optionally update pause point in the SVG file """
        # Determine default unit based on command
        default_unit = "mm" if nd_ref.options.utility_cmd == "res_adj_mm" else "in"

        try:
            dist_inches = parse_dist(nd_ref.options.dist, default_unit)
        except ValueError as e:
            return f"Error: {e}"

        self.read_from_svg(nd_ref.svg)
        self.copy_old()

        original_dist_inch = f"{max(self.old.pause_ref, 0):.3f} inches"
        updated_dist_inch = f"{max(self.old.pause_dist, 0):.3f} inches"
        original_dist_mm = f"{max(self.old.pause_ref, 0) * 25.4 :.3f} mm"
        updated_dist_mm = f"{max(self.old.pause_dist, 0)* 25.4 :.3f} mm"

        if nd_ref.options.utility_cmd == "res_adj_in":
            original_dist_text = original_dist_inch
            updated_dist_text = updated_dist_inch
            adjustment_text = f"{dist_inches:.3f} inches"
            new_pause_dist = dist_inches + max(self.old.pause_dist, 0)

            new_pos_text = f"{new_pause_dist:.3f} inches"
            if new_pause_dist <= 0:
                new_pause_dist = -1
                new_pos_text = "the file beginning"
            self.new.pause_dist = new_pause_dist

        elif nd_ref.options.utility_cmd == "res_adj_mm":
            original_dist_text = original_dist_mm
            updated_dist_text = updated_dist_mm
            adjustment_text = f"{dist_inches * 25.4:.3f} mm"
            new_pause_dist = dist_inches + max(self.old.pause_dist, 0)

            new_pos_text = f"{new_pause_dist * 25.4:.3f} mm"
            if new_pause_dist <= 0:
                new_pause_dist = -1
                new_pos_text = "the file beginning"
            self.new.pause_dist = new_pause_dist

        else:  # res_read = "res_read" Dual units and readout only.
            if self.old.pause_dist < 0:
                return "No in-progress plot data found in file.\n" +\
                        "To set up the plot to be resumed at a given point, add an offset."
            original_dist_text = original_dist_mm + " (" + original_dist_inch + ")"
            updated_dist_text = updated_dist_mm + " (" + updated_dist_inch + ")"

        if (self.old.pause_dist < 0) and (self.old.pause_ref < 0):
            return_text = "This document was configured to start plotting" +\
                            " at the beginning of the file.\n"
        elif self.old.pause_ref < 0:
            return_text = "This document was originally configured to start plotting at the " +\
                    "beginning of the file.\nThe resume position was then adjusted to " +\
                    updated_dist_text + ".\n"
        elif self.old.pause_dist == self.old.pause_ref:
            return_text = "Plot was paused after " + original_dist_text + " of pen-down travel.\n"
        else:
            return_text = "Plot was originally paused after " + original_dist_text +\
                    " of pen-down travel. The resume position was then adjusted to " +\
                    updated_dist_text + ".\n"

        if nd_ref.options.utility_cmd in ("res_adj_in", "res_adj_mm"):
            return_text += "After adding a new offset of " + adjustment_text +\
                ", the resume position is now set at " + new_pos_text + ".\n"
            self.write_to_svg(nd_ref.svg)

        return return_text

    def pause_warning(self, nd_ref):
        """ Return a warning if one starts a new plot when there's data for resuming """

        if not self.old.pause_warn:
            return None
        if nd_ref.params.pause_warning and self.old.pause_dist >= 0:
            return_text = "This document looks like it was paused while plotting.\n\n"

            if (nd_ref.called_externally[0:15] == 'nextdraw merge,') or\
                    nd_ref.options.submode != "none":
                return_text += "To resume plotting, use the Resume function instead.\n" +\
                    "To start from the beginning of the file, run this again."
            else:
                # if nd_ref.options.submode=="none": # CLI and Python API return text
                return_text += "To resume a plot, use the res_plot mode.\n" +\
                    "Or, to start from the beginning of the file, \n" +\
                    " (1) Plot the output SVG from this command or \n" +\
                    " (2) use the strip_data utility command."

            return return_text
        return None

    def remove_pause_warning(self, nd_ref):
        """ Return a warning if one starts a new plot when there's data for resuming """
        self.copy_old()              # Keep all plot data BUT
        self.new.pause_warn = 0      # Remove warning.

        if not nd_ref.plot_status.secondary:
            self.write_to_svg(nd_ref.svg)

    def res_plot_options_update(self, nd_ref):
        """
        Update certain options in NextDraw software when resuming a plot.
        These are options that, if changed, would ruin a plot rather than resuming it.
        """

        if self.old.pause_ref >= 0:  # Plot was previously started
            self.copy_old()
            nd_ref.options.model = self.old.model
            nd_ref.options.handling = self.old.handling
            nd_ref.options.reordering = self.old.reordering
            nd_ref.options.random_start = bool(self.old.rand_start)
            nd_ref.options.auto_rotate = bool(self.old.auto_rot)
            nd_ref.options.hiding = bool(self.old.hiding)
        else:
            # Synthetic resume: treat as starting a new plot.
            # Only preserve resume position; other values come from
            # user options or are set later in the flow.
            self.new.pause_dist = self.old.pause_dist
            if nd_ref.options.layer_option == 2:
                self.new.layer = nd_ref.options.layer
            else:
                self.new.layer = -1

    def update_from_options(self, nd_ref):
        """
        Update data and options that are stored in SVG for resuming later.
        """

        self.new.pause_dist = nd_ref.plot_status.stats.down_travel_inch
        self.new.pause_ref = nd_ref.plot_status.stats.down_travel_inch
        self.new.pause_warn = 1
        self.new.model = nd_ref.options.model
        self.new.handling = nd_ref.options.handling
        self.new.reordering = nd_ref.options.reordering
        self.new.rand_start = int(nd_ref.options.random_start)
        self.new.auto_rot = int(nd_ref.options.auto_rotate)
        self.new.hiding = int(nd_ref.options.hiding)


class PlotStats:
    """ PlotStats: Statistics about this plot"""

    def __init__(self):
        self.up_travel_inch = 0     # Pen-up travel distance on current page, inches
        self.down_travel_inch = 0   # Pen-down travel distance on current page, inches
        self.up_travel_tot = 0      # Total pen-up travel distance, inches
        self.down_travel_tot = 0    # Total pen-down travel distance, inches
        self.pt_estimate = 0        # Plot time estimate (for all pages), ms
        self.page_delays = 0        # Delays between pages, ms
        self.layer_delays = 0       # Delays added at beginnings of layers, ms

    def reset(self):
        ''' Reset certain attributes to defaults '''
        self.up_travel_inch = 0
        self.down_travel_inch = 0
        self.up_travel_tot = 0
        self.down_travel_tot = 0
        self.pt_estimate = 0
        self.page_delays = 0
        self.layer_delays = 0

    def next_page(self):
        ''' Zero out distance traveled for the new page '''
        self.up_travel_tot += self.up_travel_inch
        self.down_travel_tot += self.down_travel_inch
        self.up_travel_inch = 0
        self.down_travel_inch = 0

    def add_dist(self, nd_ref, distance_inch, t_d=False):
        """ add_dist: Add distance of the current plot segment to total distances """

        if nd_ref.pen.phys.z_up:
            self.up_travel_inch += distance_inch
            nd_ref.plot_status.resume.drip.dist_deque.appendleft(0)
        else:
            self.down_travel_inch += distance_inch
            if t_d:  # Count all move as happening in one of the two queued T3 moves!
                nd_ref.plot_status.resume.drip.dist_deque.appendleft(0)
            nd_ref.plot_status.resume.drip.dist_deque.appendleft(distance_inch)

    def report(self, options, message_fun, elapsed_time):
        """ report: Format and print time and distance statistics """

        self.up_travel_tot += self.up_travel_inch
        self.down_travel_tot += self.down_travel_inch

        if (options.copies > 1) and options.preview and not options.random_start:
            # Special case: When not randomizing, each page has identical print time.
            #   ->Estimate print time for a single page and multiply; it's much faster.
            self.down_travel_tot = options.copies * self.down_travel_inch
            self.up_travel_tot = options.copies * self.up_travel_inch
            self.page_delays = 1000 * options.page_delay * (options.copies - 1)
            self.layer_delays *= options.copies
            self.pt_estimate *= options.copies
            self.pt_estimate += self.page_delays

        if not options.report_time:  # Portion above this necessary for time computations.
            return

        d_dist = 0.0254 * self.down_travel_tot
        u_dist = 0.0254 * self.up_travel_tot
        t_dist = d_dist + u_dist  # Total distance

        delay_text = ""
        elapsed_text = text_utils.format_hms(elapsed_time)

        if self.layer_delays > 0:
            delay_text = ",\nincluding added delays of: " +\
                text_utils.format_hms(self.page_delays + self.layer_delays, True)  # Argument is ms
        elif self.page_delays > 0:
            delay_text = ",\nincluding page delays of: " +\
                text_utils.format_hms(self.page_delays, True)  # Argument is ms

        if options.preview:
            message_fun("Estimated print time: " +
                        text_utils.format_hms(self.pt_estimate, True) + delay_text)
            message_fun(f"Length of path to draw: {d_dist:1.3f} m")
            message_fun(f"Pen-up travel distance: {u_dist:1.3f} m")
            message_fun(f"Total movement distance: {t_dist:1.3f} m")
            message_fun("This estimate took " + elapsed_text + "\n")
        else:
            message_fun("Elapsed time: " + elapsed_text + delay_text)
            # message_fun(f"Elapsed time: {elapsed_time}") # If more digits are preferred
            message_fun("Ended at: " + time.strftime("%Y-%m-%d, %H:%M:%S"))
            message_fun(f"Length of path drawn: {d_dist:1.2f} m")
            message_fun(f"Total distance moved: {t_dist:1.2f} m\n")


class ProgressBar:
    """
    ProgressBar: Class to manage progress bar, currently used only by CLI API.
    """

    def __init__(self):
        self.p_bar = None  # Reference to TQDM progress bar object; None if not in use.
        self.sub_bar = None  # Reference to TQDM progress bar object; None if not in use.
        self.total = 0  # Total quantity, representing 100%, for main progress bar
        self.last = 0  # last quantity, for main progress bar
        self.enable = False
        self.dry_run = False    # Flag that dry run is currently taking place
        self.value_stash = [1, 0, None, 1]  # copies, digest, port, copies_left

    def review(self, status, options):
        '''
        Check configuration to see if the progress bar can be enabled.
        If so, stash and change values necessary for the dry run.
        '''

        if not status.cli_api:
            return False
        if not options.progress:
            return False
        if options.preview or options.digest > 1:
            return False
        if options.mode not in [None, "plot", "layers", "res_plot"]:
            return False
        self.enable = True
        self.value_stash = [options.copies, options.digest, status.port, status.copies_to_plot]

        # Make changes to configure for the dry run:
        self.dry_run = True  # Flag that this is a dry run; skip programmatic pauses
        options.preview = True
        options.rendering = 0  # Turn off rendering
        options.copies = 1
        status.copies_to_plot = 1
        options.digest = 0  # Disable digest output
        status.port = None
        return True

    def restore(self, nd_ref):
        ''' Restore stashed values after dry run. Return estimated time text.  '''
        self.dry_run = False
        nd_ref.options.copies = self.value_stash[0]
        nd_ref.options.digest = self.value_stash[1]
        nd_ref.plot_status.port = self.value_stash[2]
        nd_ref.plot_status.copies_to_plot = self.value_stash[3]
        nd_ref.options.preview = False  # Progress bars only run when preview is False.

        # Total distance for progress bar; Progress units are mm
        total = nd_ref.plot_status.stats.down_travel_inch +\
            nd_ref.plot_status.stats.up_travel_inch  # Use values from dry run:

        if nd_ref.options.mode == "res_plot":  # Set up progress bar to show resume position.
            total += nd_ref.plot_status.resume.old.pause_dist
            self.last = math.floor(25.4 * nd_ref.plot_status.resume.old.pause_dist)
        else:
            self.last = 0

        self.total = math.ceil(25.4 * total)

        # Report estimated print time:
        if nd_ref.options.copies > 1:
            total_print_time = nd_ref.plot_status.stats.pt_estimate * nd_ref.options.copies +\
                (nd_ref.options.copies - 1) * 1000 * nd_ref.options.page_delay
        else:
            total_print_time = nd_ref.plot_status.stats.pt_estimate
        time_txt = "Estimated print time: " +\
            text_utils.format_hms(total_print_time, True)

        if nd_ref.options.copies == 1:
            return time_txt
        if nd_ref.options.copies == 0:  # Continuous printing
            return time_txt +\
                f" per copy, with {nd_ref.options.page_delay} s between copies."

        page_delays_s = (nd_ref.options.copies - 1) * nd_ref.options.page_delay
        return time_txt + f", including {page_delays_s} s of page delays between copies."

    def launch(self, nd_ref):
        '''
        Launch the main progress bar, if enabled. Customize the description
        to indicate which page is being printed.
        '''
        if not self.enable:
            return

        from tqdm import tqdm
        total_val = math.ceil(self.total)
        if nd_ref.options.copies == 1:
            description = 'Plot Progress'
        elif nd_ref.options.copies == 0:  # continuous plotting
            the_page = -1 * nd_ref.plot_status.copies_to_plot - 1
            description = f'Copy number {the_page}'
        else:
            the_page = nd_ref.options.copies - nd_ref.plot_status.copies_to_plot
            description = f'Copy {the_page} of {nd_ref.options.copies}'

        self.p_bar = tqdm(total=total_val, mininterval=0.5, delay=0.5, position=0,
                          desc=description, initial=math.floor(self.last), leave=False,
                          unit=" mm", ascii=True)

    def launch_sub(self, nd_ref, total_in, page=True):
        ''' Launch "delay time" sub-progress bar, customized for the delay '''

        if not self.enable:
            return  # If main bar is not enabled
        if total_in < 1000:
            return  # Don't launch for < 1 s.

        total_val = math.ceil(total_in)
        if page:
            the_position = 0
            if nd_ref.options.copies == 0:  # continuous plotting
                the_page = -1 * nd_ref.plot_status.copies_to_plot - 1
                description = f'Page delay {the_page}'
            else:
                the_page = nd_ref.options.copies - nd_ref.plot_status.copies_to_plot
                description = f'Page delay {the_page} of {nd_ref.options.copies - 1}'
        else:  # A *layer* delay
            the_position = 1
            description = 'Layer delay'

        from tqdm import tqdm  # It will be loaded *before this*, but this doesn't cost anything.

        bar_type = "{desc}: {percentage:3.0f}%|{bar}|  [{elapsed_s:.1f} {unit}]"
        delay_total_s = f"of {round(total_in / 1000)} s"
        self.sub_bar = tqdm(total=total_val, mininterval=0.5, delay=0.5, position=the_position,
                            desc=description, initial=0, leave=False, unit=delay_total_s,
                            ascii=True, bar_format=bar_type)

    def update_sub_rel(self, update_amount):
        ''' Add an integer amount to the progress shown on the sub-progress bar. '''
        if self.sub_bar is None:
            return
        self.sub_bar.update(update_amount)

    def update_auto(self, status_ref):
        ''' Update the main progress bar with current travel distance '''
        if self.p_bar is None:
            return

        new_dist = 25.4 * (status_ref.down_travel_inch + status_ref.up_travel_inch)
        old_value_int = math.floor(self.last)
        new_value_int = math.floor(new_dist)
        update_amount = new_value_int - old_value_int
        self.last = new_dist
        if update_amount >= 1:
            self.p_bar.update(update_amount)

    def close(self):
        ''' Close main progress bar, if enabled '''
        self.last = 0  # Reset for future use.
        if self.p_bar is not None:
            self.p_bar.close()

    def close_sub(self):
        ''' Close sub- progress bar, if enabled '''
        if self.sub_bar is not None:
            self.sub_bar.close()


class PlotStatus:
    """
    PlotStatus: Data storage class for plot status variables
    """

    CONFIG_ITEMS = ['secondary', 'called_externally', 'cli_api', 'delay_between_copies']
    # Flags for button press, limit switch press, power loss, or loss of connection:
    MONITOR_ITEMS = ['button', 'limit', 'power', 'connection', 'monitor']

    def __init__(self):
        # self.port = None
        self.copies_to_plot = 1
        self.stopped = 0  # Status code. If a plot is stopped, record why.
        for key in self.CONFIG_ITEMS:  # Create instance variables in __init__
            setattr(self, key, False)
        for key in self.MONITOR_ITEMS:  # Create instance variables in __init__
            setattr(self, key, False)
        self.apply_defaults()  # Apply default values of the above attributes
        self.resume = ResumeStatus()
        self.progress = ProgressBar()
        self.stats = PlotStats()

    def apply_defaults(self):
        ''' Reset attributes to defaults '''
        self.port = None
        self.stopped = 0  # Default value 0 ("not stopped")
        self.delay_between_copies = False

    def reset(self):
        ''' Reset attributes and resume attributes to defaults '''
        self.apply_defaults()
        self.resume.reset()
        for key in self.MONITOR_ITEMS:
            setattr(self, key, False)


class DripCache:
    """
    Tiny class to manage data for dripfeeding; keeps track of recent moves
        in order to facilitate computing (1) the effective position through the plot
        when a pause is requested, and (2) any "braking" move needed when a pause
        is requested while moving at high speed.
    """

    def __init__(self):
        self.dist_deque = deque([], maxlen=16)
        self.last_move = None

    def reset(self):
        ''' Reset certain attributes to defaults '''
        self.dist_deque = deque([], maxlen=16)
        self.last_move = None

    def queued_dist(self, nd_ref):
        '''
        Calculate how much pen-down travel distance is queued _after_ our pause position.
        Queries the number of queued commands, and then takes the first n elements of the 
        dist_deque, which stores the pen-down distance of recent moves, newest move first.
        Use this value to offset the effective pause position.
        '''

        response = nd_ref.machine.query("QU,6")  # Query number of queued commands.
        if response is None:    # Response will be none in case of USB communication error.
            return

        queue_count = int(response)

        offset_distance = sum(islice(self.dist_deque, queue_count))
        nd_ref.plot_status.stats.down_travel_inch -= offset_distance

        # Don't let the pause position be less than the resume baseline.
        # Only applies when actually resuming; otherwise old.pause_dist may
        # be a stale value carried in from the input file's plotdata.
        if nd_ref.options.mode == "res_plot":
            nd_ref.plot_status.stats.down_travel_inch =\
                max(nd_ref.plot_status.stats.down_travel_inch,
                    nd_ref.plot_status.resume.old.pause_dist)
