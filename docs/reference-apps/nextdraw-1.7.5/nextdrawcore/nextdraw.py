# Copyright 2025 Windell H. Oskay, Bantam Tools
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
nextdraw.py

Part of the NextDraw driver software
http://bantamtools.com

See version_string below for current version and date.

Requires Python 3.10 or newer
"""
# pylint: disable=pointless-string-statement

__version__ = '1.7.5'  # Dated 2026-10-07

import copy
import gettext
import logging
# import math
import time
import socket  # for exception handling only

from lxml import etree

from nextdrawcore.nextdraw_options import common_options, versions, models, conf_handling

from nextdrawcore import path_objects
from nextdrawcore import digest_svg
from nextdrawcore import boundsclip
from nextdrawcore import plot_optimizations
from nextdrawcore import plot_status
from nextdrawcore import pen_handling
from nextdrawcore import plot_warnings
from nextdrawcore import serial_utils
from nextdrawcore import motion
from nextdrawcore import dripfeed
from nextdrawcore import preview
from nextdrawcore import homing

from nextdrawcore.plot_utils_import import from_dependency_import  # plotink
simplepath = from_dependency_import('ink_extensions.simplepath')
simplestyle = from_dependency_import('ink_extensions.simplestyle')
cubicsuperpath = from_dependency_import('ink_extensions.cubicsuperpath')
simpletransform = from_dependency_import('ink_extensions.simpletransform')
inkex = from_dependency_import('ink_extensions.inkex')
exit_status = from_dependency_import('ink_extensions_utils.exit_status')
message = from_dependency_import('ink_extensions_utils.message')
ebb3_serial = from_dependency_import('plotink.ebb3_serial')  # https://github.com/evil-mad/plotink
ebb3_motion = from_dependency_import('plotink.ebb3_motion')
plot_utils = from_dependency_import('plotink.plot_utils')
text_utils = from_dependency_import('plotink.text_utils')
requests = from_dependency_import('requests')
urllib3 = from_dependency_import('urllib3')  # for exception handling only

logger = logging.getLogger(__name__)


class NextDraw(inkex.Effect):
    """ Main class for NextDraw """

    logging_attrs = {"default_handler": message.UserMessageHandler()}

    def __init__(self, default_logging=True, user_message_fun=message.emit, params=None):
        if params is None:
            params = conf_handling.get_conf("nextdrawcore.nextdraw_conf")  # Default config file
        self.params = params

        # nextdraw.py is never actually called as a commandline tool, so why add options to
        # self.arg_parser here? Because it helps populate the self.options object
        # (argparse.Namespace) with necessary attributes and set the right defaults.
        # See self.initialize_options
        core_nextdraw_options = common_options.core_nextdraw_options(params.__dict__)
        inkex.Effect.__init__(self, common_options=[core_nextdraw_options])

        self.initialize_options()
        models.apply_model_and_handling(self, True)  # Initialize model-specific parameters

        self.version_string = __version__

        self.plot_status = plot_status.PlotStatus()
        self.pen = pen_handling.PenHandler()
        self.warnings = plot_warnings.PlotWarnings()
        self.preview = preview.Preview()
        self.homing = homing.HomingClass(self, user_message_fun)
        self.machine = ebb3_motion.EBBMotionWrap()  # Main serial class

        self.spew_debugdata = False  # Possibly add this as a PlotStatus variable
        self.set_defaults()
        self.digest = None
        self.vb_stash = [1, 1, 0, 0]  # Viewbox storage
        self.bounds = [[0, 0], [0, 0]]
        self.connected = False  # Python API variable.

        self.plot_status.secondary = False
        self.user_message_fun = user_message_fun

        if default_logging:  # logging setup
            logger.setLevel(logging.INFO)
            logger.addHandler(self.logging_attrs["default_handler"])

        if self.spew_debugdata:
            logger.setLevel(logging.DEBUG)  # by default level is INFO

    def set_up_pause_receiver(self, software_pause_event):
        """ use a multiprocessing.Event/threading.Event to communicate a
        keyboard interrupt (ctrl-C) to pause the NextDraw """
        self._software_pause_event = software_pause_event

    def receive_pause_request(self):
        """pause receiver -- for software-based pauses"""
        return hasattr(self, "_software_pause_event") and self._software_pause_event.is_set()

    def set_secondary(self, suppress_standard_out=True):
        """ If a "secondary" NextDraw called by nextdraw_control """
        self.plot_status.secondary = True
        self.called_externally = "nextdraw control"
        if suppress_standard_out:
            self.suppress_standard_output_stream()

    def suppress_standard_output_stream(self):
        """ Save values we will need later in unsuppress_standard_output_stream """
        self.logging_attrs["additional_handlers"] = [SecondaryErrorHandler(self),
                                                     SecondaryNonErrorHandler(self)]
        self.logging_attrs["emit_fun"] = self.user_message_fun
        logger.removeHandler(self.logging_attrs["default_handler"])
        for handler in self.logging_attrs["additional_handlers"]:
            logger.addHandler(handler)

    def unsuppress_standard_output_stream(self):
        """ Release logging stream """
        logger.addHandler(self.logging_attrs["default_handler"])
        if self.logging_attrs["additional_handlers"]:
            for handler in self.logging_attrs["additional_handlers"]:
                logger.removeHandler(handler)

        self.user_message_fun = self.logging_attrs["emit_fun"]

    def set_defaults(self):
        """ Set default values of certain parameters
            These are set when the class is initialized.
            Also called in plot_run() in the Python API, to ensure that
            these defaults are set before plotting additional pages."""

        self.use_layer_speed = False
        self.plot_status.reset()        # Clear serial port and pause status flags
        self.pen.reset()                # Clear pen state, lift count, layer pen height flag
        self.warnings.reset()           # Clear any warning messages
        self.time_elapsed = 0           # Available for use by python API

        self.svg_transform = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
        self.digest = None

    def initialize_options(self):
        """ Use the flags and arguments defined in __init__ to populate self.options with
            the necessary attributes and set defaults """
        self.getoptions([])
        # self.getoptions initializes self.options by calling self.arg_parser.parse_args, which is
        # not the intended use of parse_args

    def update_options(self):
        """ Parse and update certain options; called in effect and in interactive modes
            whenever the options are updated """

        if self.options.model:                      # If a model is selected
            models.apply_model_and_handling(self)   # Update model-specific parameters
            self.bounds = [[-1e-9, -1e-9],
                           [self.params.travel_x + 1e-9, self.params.travel_y + 1e-9]]

        # Input limit checking; constrain input values and prevent zero speeds:
        self.options.pen_pos_up = plot_utils.constrainLimits(self.options.pen_pos_up, 0, 100)
        self.options.pen_pos_down = plot_utils.constrainLimits(self.options.pen_pos_down, 0, 100)
        self.options.pen_rate_raise = \
            plot_utils.constrainLimits(self.options.pen_rate_raise, 1, 100)
        self.options.pen_rate_lower = \
            plot_utils.constrainLimits(self.options.pen_rate_lower, 1, 100)
        self.options.speed_pendown = plot_utils.constrainLimits(self.options.speed_pendown, 1, 100)
        self.options.speed_penup = plot_utils.constrainLimits(self.options.speed_penup, 1, 100)
        self.options.accel = plot_utils.constrainLimits(self.options.accel, 1, 100)

    def effect(self):
        """Main entry point: check to see which mode/tab is selected, and act accordingly."""
        self.start_time = time.time()

        try:
            self.plot_status.secondary
        except AttributeError:
            self.plot_status.secondary = False

        self.text_out = ''      # Text log for basic communication messages
        self.error_out = ''     # Text log for significant errors

        self.plot_status.stats.reset()  # Reset plot duration and distance statistics

        self.doc_units = "in"
        self.pen.phys.xpos = 0  # Until suggested otherwise.
        self.pen.phys.ypos = 0
        self.layer_speed_pendown = -1
        self.plot_status.copies_to_plot = 1

        self.plot_status.resume.reset()  # New values to write to file:

        self.svg_width = 0
        self.svg_height = 0
        self.rotate_page = False

        self.update_options()

        self.options.mode = self.options.mode.strip("\"")  # Input sanitization
        self.options.setup_type = self.options.setup_type.strip("\"")
        self.options.utility_cmd = self.options.utility_cmd.strip("\"")
        self.options.page_delay = max(self.options.page_delay, 0)

        try:
            self.called_externally
        except AttributeError:
            self.called_externally = ""
        ext_version_check = versions.min_merge_version(self.called_externally, "1.7.0")
        if ext_version_check is not None:
            self.user_message_fun(ext_version_check)
            return

        if self.options.mode == "options":
            return
        if self.options.mode == "timing":
            return
        if self.options.mode == "version":
            # Return the version of _this python script_.
            self.user_message_fun(self.version_string)
            return
        if self.options.mode == "utility":
            if self.options.utility_cmd == "none":
                return  # No option selected. Do nothing and return no error.
            if self.options.utility_cmd == "strip_data":
                preview.strip_data(self)
                self.user_message_fun("Previews and NextDraw software data " +
                                      "have been removed from the SVG file.")
                return
            if self.options.utility_cmd in ("res_read", "res_adj_in", "res_adj_mm"):
                self.svg = self.document.getroot()
                self.user_message_fun(self.plot_status.resume.manage_offset(self))
                self.res_dist = max(self.plot_status.resume.new.pause_dist*25.4, 0)  # Python API
                return
            if self.options.utility_cmd == "list_names":  # Run before regular serial connection!
                self.name_list = ebb3_serial.list_named_ebbs()  # Variable available for python API
                if not self.name_list:
                    self.user_message_fun(gettext.gettext("No named plotters located.\n"))
                else:
                    self.user_message_fun(gettext.gettext("List of attached plotters:"))
                    for detected_ebb in self.name_list:
                        self.user_message_fun(detected_ebb)
                return

        if self.options.mode == "res_plot":
            self.options.copies = 1

        if self.options.mode == "setup":
            # setup mode -> either align, cycle, or homing modes.
            self.options.mode = self.options.setup_type

        if (self.options.mode == "utility") and (self.options.utility_cmd == "toggle"):
            self.options.mode = "toggle"

        if self.options.digest == 2:  # Generate digest only; do not run plot or preview
            self.options.preview = True  # Disable serial communication; restrict certain functions

        if not self.options.preview:
            self.serial_connect(caller="nextdraw")

        if self.options.mode == "sysinfo":
            versions.report_version_info(self, self.user_message_fun)

        if (self.machine.err is not None) and not self.options.preview:
            self.user_message_fun(f"Error:\n\n{self.machine.err}")
            return

        if self.options.mode in ('align', 'toggle', 'cycle', 'find_home'):
            self.setup_command()
            self.warnings.report(self.called_externally, self.user_message_fun)  # print warnings
            return

        if self.options.mode == "utility":
            self.utility_command()  # Handle utility commands that use both power and usb.
            self.warnings.report(self.called_externally, self.user_message_fun)  # print warnings
            return

        self.svg = self.document.getroot()
        self.plot_status.resume.update_needed = False
        self.plot_status.resume.new.model = self.options.model  # Save model in file

        if self.options.mode in ("plot", "layers", "res_plot"):
            # Read saved data from SVG file, including plob version information
            self.plot_status.resume.read_from_svg(self.svg)

        if self.options.mode == "res_plot":  # Initialization for resuming plots
            if self.plot_status.resume.old.pause_dist >= 0:
                # Certain options cannot be changed when resuming; enforce that:
                self.plot_status.resume.res_plot_options_update(self)
                self.update_options()
            else:
                self.user_message_fun(gettext.gettext(
                    "No in-progress plot data found in file; unable to resume."))
                self.plot_cleanup()     # Revert document; nothing plotted.
                return
        else:  # Only in "plot" or "layers": Check if there's a plot in progress...
            return_text = self.plot_status.resume.pause_warning(self)
            if return_text is not None:
                if not self.plot_status.secondary:  # Do not print warning for secondary units.
                    self.user_message_fun(return_text)
                self.plot_cleanup()     # Revert document; nothing plotted.
                self.plot_status.resume.remove_pause_warning(self)  # AFTER reverting...
                return

        # Handle --offset_start flag for plot, layers, and res_plot modes
        if self.options.offset_start and self.options.mode in ("plot", "layers", "res_plot"):
            try:
                dist_inches = plot_status.parse_dist(self.options.dist, "in")
            except ValueError as e:
                self.user_message_fun(f"Error: {e}")
                return

            if self.options.mode in ("plot", "layers"):
                # For plot/layers: offset from file beginning, must be >= 0
                if dist_inches < 0:
                    self.user_message_fun(
                        "Error: dist must be >= 0 for plot and layers modes with --offset_start.")
                    return

                # Set up synthetic resume state
                self.plot_status.resume.old.pause_dist = dist_inches
                self.plot_status.resume.old.pause_ref = -1  # Synthetic: never actually paused

                # Set layer_option based on mode
                if self.options.mode == "layers":
                    self.options.layer_option = 2
                else:
                    self.options.layer_option = 1

                # Convert to res_plot for execution
                self.options.mode = "res_plot"

                # Apply synthetic resume state
                self.plot_status.resume.res_plot_options_update(self)
                self.update_options()

            else:  # res_plot mode
                # For res_plot: relative adjustment, can be negative
                current_dist = max(self.plot_status.resume.old.pause_dist, 0)
                new_dist = current_dist + dist_inches
                if new_dist < 0:
                    new_dist = 0  # Clamp to file beginning
                self.plot_status.resume.old.pause_dist = new_dist

        if self.options.mode in ("plot", "layers", "res_plot"):
            self.plot_status.copies_to_plot = self.options.copies
            if self.plot_status.copies_to_plot == 0:  # Special case: Continuous copies selected
                self.plot_status.copies_to_plot = -1  # Flag for continuous copies

            if self.options.preview and not self.options.random_start:
                # Special preview case: Without randomizing, pages have identical print time:
                self.plot_status.copies_to_plot = 1

            if (self.options.mode == "plot") and (self.options.layer_option == 2):
                self.options.mode = "layers"  # Detect conditions to use layers mode

            if self.options.mode == "layers":
                self.plot_status.resume.new.layer = self.options.layer

            if self.options.mode == "plot":
                self.plot_status.resume.new.layer = -1  # Plot all layers

            # Parse & digest SVG document, perform initial optimizations, prepare to resume:
            if not self.prepare_document():
                return

            if self.options.digest == 2:  # Generate digest only; do not run plot or preview
                self.plot_cleanup()     # Revert document to save plob & print time elapsed
                self.plot_status.resume.new.plob_version = str(path_objects.PLOB_VERSION)
                self.plot_status.resume.write_to_svg(self.svg)
                self.warnings.report(False, self.user_message_fun)  # print warnings
                return

            if self.options.mode == "res_plot":  # Crop digest up to when the plot resumes:
                self.digest.crop(self.plot_status.resume.old.pause_dist)

            # CLI PROGRESS BAR: SET UP DRY RUN TO ESTIMATE PLOT LENGTH & TIME
            if self.plot_status.progress.review(self.plot_status, self.options):
                self.plot_document()  # "Dry run": Estimate plot length & time

                self.user_message_fun(self.plot_status.progress.restore(self))
                self.plot_status.stats.reset()  # Reset plot duration and distance statistics

            if self.options.mode == "res_plot":
                # Update so that if the plot is paused, we can resume again
                self.plot_status.stats.down_travel_inch = self.plot_status.resume.old.pause_dist

            first_copy = True
            while self.plot_status.copies_to_plot != 0:

                self.preview.reset()  # Clear preview data before starting each plot
                self.plot_status.resume.update_needed = True
                self.plot_status.copies_to_plot -= 1

                if first_copy:
                    first_copy = False
                else:
                    self.plot_status.stats.next_page()  # Update distance stats for next page
                    if self.options.random_start:
                        self.randomize_optimize()  # Only need to re-optimize if randomizing
                self.plot_document()
                dripfeed.page_layer_delay(self, between_pages=True)  # Delay between pages

            self.plot_cleanup()  # Revert document, print time reports, send webhooks

        if self.plot_status.resume.update_needed:
            if self.options.digest:  # i.e., if self.options.digest > 0
                self.plot_status.resume.new.plob_version = str(path_objects.PLOB_VERSION)
            self.plot_status.resume.write_to_svg(self.svg)
        if self.machine.port is not None:
            self.pen.servo_revert(self)  # Reset pen heights. Important if we were paused.
            if self.machine.caller == "nextdraw":
                self.disconnect()  # Only close serial port if it was opened here.
        self.warnings.report(self.called_externally, self.user_message_fun)  # print warnings

    def setup_command(self):
        """ Commands from the setup modes. Need power and USB, but not SVG file. """

        if self.options.preview:
            self.user_message_fun('Command unavailable while in preview mode.')
            return

        if self.machine.port is None:
            return

        self.query_ebb_voltage()
        self.pen.servo_init(self)  # This function handles the "toggle" mode.

        if self.options.mode == "align":
            self.pen.pen_raise(self)
            self.machine.motors_disable()
        elif self.options.mode == "cycle":
            self.pen.cycle(self)
        elif self.options.mode == "find_home":
            if self.options.homing and self.params.auto_home:
                serial_utils.enable_motors(self)
                self.machine.var_write(0, 12)  # Mark machine as not-homed, to allow homing.
                self.homing.find_home()
                # self.machine.clear_accumulators()
            elif self.params.auto_home:  # Supported by model but not enabled
                self.user_message_fun('Automatic homing is disabled in settings.')
            else:  # Not supported by model but not enabled
                self.user_message_fun('The selected plotter model, ' +
                                      f'{self.params.model_name}, ' +
                                      'does not support automatic homing.')

    def utility_command(self):
        """ Utility mode commands that need USB connectivity and don't need SVG file """

        if self.options.preview:  # First: Commands that require serial but not power
            self.user_message_fun('Command unavailable while in preview mode.')
            return
        if self.machine.port is None:
            return

        if self.options.utility_cmd == "bootload":
            success = self.machine.bootload()
            if success:
                self.user_message_fun(
                    "Entering bootloader mode for firmware programming.\n" +
                    "To resume normal operation, you may need to first\n" +
                    "press the reset button or disconnect the machine from\n" +
                    "both USB and power.")
                self.disconnect()  # Disconnect; end USB serial session
            else:
                logger.error('Failed while trying to enter bootloader.')
            return

        if self.options.utility_cmd == "read_name":
            self.user_message_fun(self.machine.name)

        if (self.options.utility_cmd).startswith("write_name"):
            temp_string = self.options.utility_cmd
            temp_string = temp_string.split("write_name", 1)[1]  # Get part after "write_name"
            temp_string = temp_string[:16]  # Only use first 16 characters in name
            if not temp_string:
                temp_string = ""  # Use empty string to clear nickname.

            renamed = self.machine.write_nickname(temp_string)
            if renamed is True:
                if temp_string == "":
                    self.user_message_fun('Writing "blank" Nickname; setting to default.')
                else:
                    self.user_message_fun(f'Nickname "{temp_string}" written.')
                self.user_message_fun('Rebooting EBB.')
            else:
                logger.error('Error encountered while writing nickname.')
            self.machine.command('R')   # Soft reset
            self.machine.reboot()       # Reboot required after writing nickname
            self.disconnect()  # Disconnect; end USB serial session

            return

        self.query_ebb_voltage()  # Next: Commands that also require both power to move motors:
        if self.options.utility_cmd == "raise_pen":
            self.pen.servo_init(self)  # Initializes to pen-up position
        elif self.options.utility_cmd == "lower_pen":
            self.pen.servo_init(self)  # Initializes to pen-down position
        elif self.options.utility_cmd == "enable_xy":
            serial_utils.enable_motors(self)
        elif self.options.utility_cmd == "disable_xy":
            self.machine.motors_disable()
        elif self.options.utility_cmd == "set_home":
            self.homing.set_home()
        elif self.options.utility_cmd in\
                ["walk_home", "walk_x", "walk_y", "walk_mmx", "walk_mmy"]:
            self.pen.servo_init(self)
            serial_utils.enable_motors(self)  # Set motor resolution
            if not self.homing.find_home():  # Trigger homing sequence if not homed
                return

            serial_utils.exhaust_queue(self)  # Wait until all motion stops

            if self.options.utility_cmd == "walk_home":  # Execute two-part move Home
                serial_utils.write_step_offsets(self, 0, 0)  # Reset 2D offsets to (0, 0)
                self.homing.read_position()  # Set XY position from the EBB step counter
                self.go_to_position(min(self.pen.phys.xpos, 0.01),
                                    min(self.pen.phys.ypos, 0.01), ignore_limits=True)
                self.homing.precision_move_to(0, 0)  # Final move to correct remaining offset
                return

            self.homing.read_position()  # Update XY position from the EBB step counter
            xpos_temp, ypos_temp = self.pen.phys.xpos, self.pen.phys.ypos

            # Determine default unit based on command
            default_unit = "mm" if self.options.utility_cmd in ("walk_mmx", "walk_mmy") else "in"

            try:
                dist_inches = plot_status.parse_dist(self.options.dist, default_unit)
            except ValueError as e:
                self.user_message_fun(f"Error: {e}")
                return

            if self.options.utility_cmd in ("walk_y", "walk_mmy"):
                n_delta_x = 0
                n_delta_y = dist_inches
            elif self.options.utility_cmd in ("walk_x", "walk_mmx"):
                n_delta_y = 0
                n_delta_x = dist_inches

            self.homing.adjust_origin_offset(n_delta_x, n_delta_y)  # Update position offsets
            self.go_to_position(xpos_temp, ypos_temp, ignore_limits=True)

            # Correction move to end up at exact step position, avoid error accumulation:
            self.homing.precision_move_to(xpos_temp, ypos_temp)

    def prepare_document(self):
        """
        Prepare the SVG document for plotting: Create the plot digest, join nearby ends,
        and perform supersampling. If not using randomization, then optimize the digest as well.
        """
        if not self.get_doc_props():
            logger.error(gettext.gettext('This document does not have valid dimensions.'))
            logger.error(gettext.gettext(
                'The page size should be in either millimeters (mm) or inches (in).\r\r'))
            logger.error(gettext.gettext(
                'Consider starting with the Letter landscape or '))
            logger.error(gettext.gettext('the A4 landscape template.\r\r'))
            logger.error(gettext.gettext('The page size may also be set in Inkscape,\r'))
            logger.error(gettext.gettext('using File > Document Properties.'))
            return False

        if not hasattr(self, 'backup_original'):
            self.backup_original = copy.deepcopy(self.document)

        # Modifications to SVG -- including re-ordering and text substitution
        #   may be made at this point, and will not be preserved.
        # Try to get valid viewBox scaling, fallback to PX_PER_INCH if needed
        v_b = self.svg.get('viewBox')
        vb_scale_out = plot_utils.vb_scale_2(v_b, self.svg.get('preserveAspectRatio'),
                                             self.svg_width, self.svg_height)
        if vb_scale_out is not None:  # Valid viewBox: Use the calculated scaling
            s_x, s_y, o_x, o_y = vb_scale_out
        else:  # No viewBox or invalid viewBox - use PX_PER_INCH scaling
            s_x = 1.0 / float(plot_utils.PX_PER_INCH)
            s_y = s_x
            o_x = 0.0
            o_y = 0.0
        self.vb_stash = s_x, s_y, o_x, o_y

        # Initial transform of document is based on viewbox, if present:
        self.svg_transform = simpletransform.parseTransform(
                f'scale({s_x:.6E},{s_y:.6E}) translate({o_x:.6E},{o_y:.6E})')

        valid_plob = False
        if self.plot_status.resume.old.plob_version:
            logger.debug('Checking Plob')
            valid_plob = digest_svg.verify_plob(self.svg, self.options.model, self.bounds,
                                                self.svg_width, self.svg_height)
        if valid_plob:
            logger.debug('Valid plob found; skipping standard pre-processing.')
            self.digest = path_objects.DocDigest()
            self.digest.from_plob(self.svg, self.svg_width, self.svg_height)
            self.digest.layer_filter(self.plot_status.resume.new.layer)
            self.backup_original = copy.deepcopy(self.document)
            self.plot_status.resume.new.plob_version = str(path_objects.PLOB_VERSION)
        else:  # Process the input SVG into a simplified, restricted-format DocDigest object:
            digester = digest_svg.DigestSVG(self)   # Initialize class
            if self.options.hiding:                 # Process all visible layers
                digest_params = [s_x, s_y, -2]
            else:  # Process only selected layer, if in layers mode
                digest_params = [s_x, s_y, self.plot_status.resume.new.layer]

            self.digest = digester.process_svg(self.svg, digest_params, self.svg_transform)

            if self.rotate_page:  # Rotate digest
                self.digest.rotate(self.params.auto_rotate_ccw)

            if self.options.hiding:
                """
                Perform hidden-line clipping at this point, based on object
                    fills, clipping masks, and document and plotting bounds, via self.bounds
                """
                # clipping involves a non-pure Python dependency (pyclipper), so only import
                # when necessary
                from nextdrawcore.clipping import ClipPathsProcess
                bounds = ClipPathsProcess.calculate_bounds(self.bounds, self.svg_height,
                                                           self.svg_width,
                                                           self.params.clip_to_page,
                                                           self.rotate_page)
                # flattening removes essential information for the clipping process
                assert not self.digest.flat
                self.digest.layers = ClipPathsProcess().run(self.digest.layers,
                                                            bounds, clip_on=True)
                self.digest.layer_filter(self.plot_status.resume.new.layer)  # For Layers mode
                self.digest.remove_unstroked()  # Only stroked objects can plot
                self.digest.flatten()  # Flatten digest before optimizations and plotting
            else:
                """ Clip digest at plot bounds """
                if self.rotate_page:
                    doc_bounds = [self.svg_height + 1e-9, self.svg_width + 1e-9]
                else:
                    doc_bounds = [self.svg_width + 1e-9, self.svg_height + 1e-9]
                out_of_bounds_flag =\
                    boundsclip.clip_at_bounds(self.digest, self.bounds, doc_bounds,
                                              self.params.bounds_tolerance,
                                              self.params.clip_to_page)
                if out_of_bounds_flag:
                    self.warnings.add_new('bounds', self.params.model_name)

            """
            Possible future work: Perform automatic hatch filling at this point, based on object
                fill colors and possibly other factors.
            """

            """ Optimize digest  """
            plot_optimizations.connect_nearby_ends(self.digest,
                                                   self.params.min_gap, self.options.reordering)
            plot_optimizations.supersample(self.digest, self.params.curve_tolerance/3)
            # plot_optimizations.supersample_new(self) # WIP supersampling disabled at present.
            self.randomize_optimize(True)  # Do plot randomization & optimizations

        # If it is necessary to save as a Plob, that conversion can be made like so:
        # plob = self.digest.to_plob() # Unnecessary re-conversion for testing only
        # self.digest.from_plob(plob)  # Unnecessary re-conversion for testing only
        return True

    def randomize_optimize(self, first_copy=False):
        """ Randomize start points & perform reordering """

        if self.plot_status.resume.new.plob_version != "n/a":
            return  # Working from valid plob; do not perform any optimizations.
        if self.options.random_start:
            if self.options.mode != "res_plot":  # Use old rand seed when resuming a plot.
                self.plot_status.resume.new.rand_seed = int(time.time()*100)
            plot_optimizations.randomize_start(self.digest, self.plot_status.resume.new.rand_seed)

        plot_optimizations.reorder(self.digest, self.options.reordering)

        if first_copy and self.options.digest:  # Will return Plob, not full SVG; back it up here.
            self.backup_original = copy.deepcopy(self.digest.to_plob())

    def plot_document(self):
        """ Plot the prepared SVG document, if so selected in the interface """
        if not self.options.preview:
            self.options.rendering = 0  # Only render previews if we are in preview mode.
            if self.machine.port is None:
                return
            if not self.query_ebb_voltage():
                return

        self.pen.servo_init(self)
        self.pen.pen_raise(self)
        serial_utils.enable_motors(self)  # Set plotting resolution

        if not self.homing.find_home():
            return

        try:  # wrap everything in a try so we can be sure to close the serial port
            self.plot_status.progress.launch(self)

            self.plot_doc_digest(self.digest)  # Step through and plot contents of document digest
            self.pen.pen_raise(self)
            if self.plot_status.stopped == 0:  # Return Home after normal plot
                self.plot_status.resume.new.clean()  # Clear flags indicating resume status

                # Move _close_ to Home (really, the *plot origin*), quickly.
                self.go_to_position(min(self.pen.phys.xpos, 0.1), min(self.pen.phys.ypos, 0.1))
                # Then, add final move to correct any offset from previous position:
                self.homing.precision_move_to(0, 0)
        finally:  # In case of an exception and loss of the serial port...
            pass
        self.plot_status.progress.close()

    def plot_cleanup(self):
        """
        Perform standard actions after a plot or the last copy from a set of plots:
        Revert file, render previews, print time reports, run webhook.

        Reverting is back to original SVG document, prior to adding preview layers.
            and prior to saving updated "plotdata" progress data in the file.
            No changes to the SVG document prior to this point will be saved.

        Doing so allows us to use routines that alter the SVG prior to this point,
            e.g., plot re-ordering for speed or font substitutions.
        """
        if not hasattr(self, 'backup_original'):
            return
        self.document = copy.deepcopy(self.backup_original)
        self.svg = self.document.getroot()  # Get document root

        if self.options.digest == 2:  # Save Plob file only and exit.
            elapsed_time = time.time() - self.start_time
            self.time_elapsed = elapsed_time  # Available for use by python API
            if self.options.report_time and not self.called_externally:  # Print time only
                self.user_message_fun("Elapsed time: " + text_utils.format_hms(elapsed_time))
            return

        self.preview.render(self)  # Render preview on the page, if enabled and in preview mode

        if self.plot_status.progress.enable and self.plot_status.stopped == 0:
            self.user_message_fun("\nNextDraw plot complete.\n")  # If sequence ended normally.
        elapsed_time = time.time() - self.start_time
        self.time_elapsed = elapsed_time  # Available for use by python API

        if not self.called_externally:  # Compile time estimates & print time reports
            self.plot_status.stats.report(self.options, self.user_message_fun, elapsed_time)
            self.pen.status.report(self, self.user_message_fun)
            if self.options.report_time and self.plot_status.resume.new.plob_version != "n/a":
                self.user_message_fun("Document printed from valid Plob digest.")

        if self.options.webhook and not self.options.preview:
            if self.options.webhook_url is not None:
                self.options.webhook_url.strip()
                if self.options.webhook_url[0:4] != "http":
                    self.options.webhook_url = str('https://' + self.options.webhook_url)

                payload_note = ""
                if hasattr(self.digest, 'name'):
                    if isinstance(self.digest.name, str) and (self.digest.name != ""):
                        payload_note = f"File {self.digest.name}, "
                payload = "Plot complete. " + payload_note +\
                    f"Time {text_utils.format_hms(elapsed_time)}, " +\
                    f"Machine: {self.machine.name}"

                payload = payload.encode(encoding='utf-8')
                self.options.webhook_url = self.options.webhook_url.encode(encoding='utf-8')
                try:
                    requests.post(self.options.webhook_url, data=payload, timeout=7)
                except (TimeoutError, urllib3.exceptions.ConnectTimeoutError,
                        urllib3.exceptions.MaxRetryError, requests.exceptions.ConnectTimeout):
                    self.user_message_fun("Webhook notification failed (Timed out).\n")
                except (urllib3.exceptions.NewConnectionError,
                        socket.gaierror, requests.exceptions.ConnectionError):
                    self.user_message_fun("An error occurred while posting webhook. " +
                                          "Check your internet connection and webhook URL.\n")

    def plot_doc_digest(self, digest):
        """
        Step through the document digest and plot each of the vertex lists.

        Takes a flattened path_objects.DocDigest object as input. All
        selection of elements to plot and their rendering, including
        transforms, needs to be handled before this routine.
        """

        if not digest:
            return

        for layer in digest.layers:

            self.pen.end_temp_height(self)
            old_use_layer_speed = self.use_layer_speed  # A Boolean
            old_layer_speed_pendown = self.layer_speed_pendown  # Numeric value
            self.pen.pen_raise(self)  # Raise pen prior to computing layer properties

            self.eval_layer_props(layer.props)

            for path_item in layer.paths:
                if self.plot_status.stopped:
                    return
                self.plot_polyline(path_item)
            self.use_layer_speed = old_use_layer_speed  # Restore old layer status variables
            if self.layer_speed_pendown != old_layer_speed_pendown:
                self.layer_speed_pendown = old_layer_speed_pendown
                serial_utils.enable_motors(self)  # Set speed value variables for this layer.
            self.pen.end_temp_height(self)

    def eval_layer_props(self, layer_props):
        """
        Check for encoded pause, delay, speed, or height in the layer name, and act upon them,
        using layer name syntax.
        """

        if layer_props.pause:  # Insert programmatic pause
            if not self.plot_status.progress.dry_run:  # Skip during dry run only
                if self.plot_status.stopped == 0:  # If not already stopped
                    self.plot_status.stopped = -1  # Set flag for programmatic pause
                self.pause_check()  # Carry out the pause, or resume if required.

        old_speed = self.layer_speed_pendown
        self.use_layer_speed = False
        self.layer_speed_pendown = -1

        if layer_props.delay:
            dripfeed.page_layer_delay(self, between_pages=False, delay_ms=layer_props.delay)
        if layer_props.height is not None:  # New height will be used when we next lower the pen.
            self.pen.set_temp_height(self, layer_props.height)
        if layer_props.speed:
            self.use_layer_speed = True
            self.layer_speed_pendown = layer_props.speed

        if self.layer_speed_pendown != old_speed:
            serial_utils.enable_motors(self)  # Set speed value variables for this layer.

    def plot_polyline(self, path_item):
        """
        Plot a polyline object; a single pen-down XY movement.
        - No transformations, no curves, no neat clipping at document bounds;
            those are all performed _before_ we get to this point.
        - Truncate motion, brute-force, at travel bounds, without mercy or printed warnings.
        """

        vertex_list = path_item.subpaths[0]

        if self.plot_status.stopped:
            logger.debug('Polyline: self.plot_status.stopped.')
            return
        if not vertex_list:
            logger.debug('No vertex list to plot. Returning.')
            return
        if len(vertex_list) < 2:
            logger.debug('No full segments in vertex list. Returning.')
            return

        self.pen.pen_raise(self)  # Raise, if necessary, prior to pen-up travel to first vertex

        down_travel_last = self.plot_status.stats.down_travel_inch
        polyline_length = path_item.length()

        for vertex in vertex_list:
            vertex[0], _t_x = plot_utils.checkLimitsTol(vertex[0], 0, self.bounds[1][0], 2e-9)
            vertex[1], _t_y = plot_utils.checkLimitsTol(vertex[1], 0, self.bounds[1][1], 2e-9)
            # if _t_x or _t_y:
            #     logger.debug('Travel truncated to bounds at plot_polyline.')

        # Pen up straight move, zero velocity at endpoints, to first vertex location
        self.go_to_position(vertex_list[0][0], vertex_list[0][1])

        # Plan and feed trajectory, including lowering and raising pen before and after:
        the_trajectory = motion.trajectory(self, vertex_list)

        # self.user_message_fun(f'the_trajectory: {the_trajectory}')

        dripfeed.feed(self, the_trajectory)
        if self.plot_status.stopped == 0:  # In case everything went well...
            self.plot_status.stats.down_travel_inch = down_travel_last + polyline_length

    def go_to_position(self, x_dest, y_dest, ignore_limits=False, xyz_pos=None):
        '''
        Immediate XY move to destination, using normal motion planning. Replaces legacy
        function "plot_seg_with_v", assuming zero initial and final velocities.
        '''

        target_data = (x_dest, y_dest, 0, 0, ignore_limits)
        the_trajectory = motion.compute_segment(self, target_data, xyz_pos)
        # self.user_message_fun(f'Trajectory errors: {the_trajectory[1]}')
        dripfeed.feed(self, the_trajectory[0])

    def pause_check(self):
        """ Manage Pause functionality and stop plot if requested or at certain errors """
        if self.plot_status.stopped > 0:
            return  # Plot is already stopped. No need to proceed.

        pause_button_pressed = self.plot_status.resume.check_button(self)

        if self.receive_pause_request():                # Keyboard interrupt detected!
            self.plot_status.stopped = -103             # Code 104: "Keyboard interrupt"
            if self.plot_status.delay_between_copies:   # However... it could have been...
                self.plot_status.stopped = -2           # Paused between copies (OK).

        if self.plot_status.power:
            self.plot_status.stopped = -105     # Code 105: "Lost power"
            self.user_message_fun('Plot stopped because loss of power detected.\n')
            self.machine.var_write(0, 12)       # Write variable: Index 12 (homing): Not homed
            self.machine.var_write(0, 13)       # Write variable: Index 13 (power): Power lost

        if self.plot_status.stopped == -1:
            self.user_message_fun('Plot paused programmatically.\n')
        if self.plot_status.stopped == -103:
            self.user_message_fun('\nPlot paused by user input.\n')

        if (self.plot_status.stopped < 0) or (pause_button_pressed != 0):
            # Update pause position stats, subtracting any queued pen-down moves,
            if self.plot_status.stopped != -1:  # except in cases of programmatic pauses
                self.plot_status.resume.drip.queued_dist(self)

        if pause_button_pressed == -1:  # Possible future change: Customize with model name
            self.user_message_fun('\nError: USB connection lost during plot. ' +
                f'[Position: {25.4 * self.plot_status.stats.down_travel_inch:.3f} mm]\n')

            self.connected = False              # Python interactive API variable
            self.plot_status.stopped = -104     # Code 104: "Lost connectivity"

        if pause_button_pressed == 1:
            if self.plot_status.delay_between_copies:
                self.plot_status.stopped = -2  # Paused between copies.
            elif self.options.mode == "interactive":
                logger.warning('Plot halted by button press during interactive session.')
                # TODO: Customize response depending if automatic homing is available.
                # TODO: Also customize response with model name
                # logger.warning('Manually home the machine before plotting next item.\n')
                self.plot_status.stopped = -102  # Code 102: "Paused by button press"
            else:
                self.user_message_fun('Plot paused by button press.\n')
                self.plot_status.stopped = -102  # Code 102: "Paused by button press"

        if self.plot_status.stopped == -2:
            self.user_message_fun('Plot sequence ended between copies.\n')

        if self.plot_status.stopped in (-1, -102, -103):
            self.user_message_fun('(Paused after: ' +
                f'{25.4 * self.plot_status.stats.down_travel_inch:.3f} mm of pen-down travel.)')

        if self.plot_status.stopped < 0:  # Stop plot
            self.pen.pen_raise(self)
            if not self.plot_status.delay_between_copies and \
                    not self.plot_status.secondary and self.options.mode != "interactive":
                # Only print if we're not in the delay between copies, nor a "second" unit.
                if self.plot_status.stopped not in [-104, -105]:  # Loss of USB, power
                    self.user_message_fun('Use the resume feature to continue.\n')
            self.plot_status.stopped = - self.plot_status.stopped
            self.plot_status.copies_to_plot = 0

            if self.options.mode not in ("plot", "layers", "res_plot"):
                return  # Only update pause_dist in the modes that plot the document.

            self.plot_status.resume.update_from_options(self)  # Update data to save in SVG

    def serial_connect(self, caller=None):
        """ Connect to EBB over USB """
        # Future work: Remove this function
        if serial_utils.connect(self, self.user_message_fun, logger, caller):
            self.connected = True  # Variable available in the Python interactive API.
        else:
            self.plot_status.stopped = 101  # Will become exit code 101; failed to connect

    def query_ebb_voltage(self):
        """ Check that power supply is detected at beginning of plot """
        serial_utils.read_status_byte(self)
        if self.plot_status.power:  # Power lost since we were previously using machine
            self.machine.clear_steps()      # Clear step counter
            self.machine.var_write(0, 12)   # Write variable: Index 12 (homing): Not homed
            self.machine.var_write(0, 13)   # Write variable: Index 13 (power): Power lost
            self.plot_status.power = False  # Clear flag; we have acknowledged the power loss.

        self.plot_status.button = False     # Clear flag
        self.plot_status.limit = False      # Clear flag

        return serial_utils.query_voltage(self)

    def get_doc_props(self):
        """
        Get the document's height and width attributes from the <svg> tag. Use a default value in
        case the property is not present or is expressed in units of percentages.
        """

        self.svg_height = plot_utils.getLengthInches(self, 'height')
        self.svg_width = plot_utils.getLengthInches(self, 'width')

        width_string = self.svg.get('width')
        if width_string:
            _value, units = plot_utils.parseLengthWithUnits(width_string)
            self.doc_units = units
        if self.svg_height is None or self.svg_width is None:
            return False
        if self.options.auto_rotate and (self.svg_height > self.svg_width):
            self.rotate_page = True
        return True

    def get_output(self):
        """Return serialized copy of svg document output"""
        result = etree.tostring(self.document)
        return result.decode("utf-8")

    def disconnect(self):
        '''End USB serial session; disconnect from EBB. '''
        if self.options.mode != "utility":
            serial_utils.exhaust_queue(self)

        # Debug readouts
        # step_pos = self.machine.query_steps()
        # self.user_message_fun(f"Final step pos: {step_pos}")
        # result = self.machine.query("QU,4") # Read EBB stack max depth
        # self.user_message_fun(f'Max stack depth: {result}')
        # result = self.machine.query("QU,200") #  Read Accumulators
        # self.user_message_fun(f'Accumulators: {result}')

        self.machine.disconnect()
        self.connected = False  # Python interactive API variable


class SecondaryLoggingHandler(logging.Handler):
    '''To be used for logging to NextDraw.text_out and NextDraw.error_out.'''
    def __init__(self, nextdraw, log_name, level=logging.NOTSET):
        super().__init__(level=level)

        log = getattr(nextdraw, log_name) if hasattr(nextdraw, log_name) else ""
        setattr(nextdraw, log_name, log)

        self.nextdraw = nextdraw
        self.log_name = log_name

        self.setFormatter(logging.Formatter())  # pass message through unchanged

    def emit(self, record):
        assert(hasattr(self.nextdraw, self.log_name))
        new_log = getattr(self.nextdraw, self.log_name) + "\n" + self.format(record)
        setattr(self.nextdraw, self.log_name, new_log)


class SecondaryErrorHandler(SecondaryLoggingHandler):
    '''Handle logging for "secondary" machines, plotting alongside primary.'''
    def __init__(self, nextdraw):
        super().__init__(nextdraw, 'error_out', logging.ERROR)


class SecondaryNonErrorHandler(SecondaryLoggingHandler):
    class ExceptErrorsFilter(logging.Filter):
        def filter(self, record):
            return record.levelno < logging.ERROR

    def __init__(self, nextdraw):
        super().__init__(nextdraw, 'text_out')
        self.addFilter(self.ExceptErrorsFilter())


if __name__ == '__main__':
    logging.basicConfig()
    e = NextDraw()
    exit_status.run(e.affect)
