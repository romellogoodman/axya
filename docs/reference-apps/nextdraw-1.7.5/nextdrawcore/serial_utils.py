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
serial_utils.py

This module modularizes some serial functions.

Part of the NextDraw driver software
http://bantamtools.com

Requires Python 3.10 or newer.

"""

import time
# import math

from nextdrawcore.plot_utils_import import from_dependency_import # plotink
plot_utils = from_dependency_import('plotink.plot_utils')

# inkex = from_dependency_import('ink_extensions.inkex') # Optional for debug printing

def connect(nd_ref, message_fun, logger, caller_in=None):

    """ Connect to plotter over USB """
    if nd_ref.options.port_config == 1: # port_config value "1": Use first available machine.
        nd_ref.options.port = None
    if not nd_ref.options.port: # No port given; Try to connect to first available machine.
        nd_ref.machine.connect(caller=caller_in)
    elif str(type(nd_ref.options.port)) in (
            "<type 'str'>", "<type 'unicode'>", "<class 'str'>"):
        # This function may be passed a port name to open (and later close).
        nd_ref.options.port = str(nd_ref.options.port).strip('\"')
        nd_ref.machine.connect(nd_ref.options.port, caller=caller_in)

    if nd_ref.machine.port is None:
        model_name = nd_ref.params.model_name if (nd_ref.options.model != 0) else "machine"
        failed_text = 'Failed to connect to ' + model_name
        if nd_ref.options.port:
            message_fun(failed_text + " " + str(nd_ref.options.port) + ".")
        else:
            message_fun(failed_text + ".")
        return False

    if nd_ref.machine.port is not None:
        logger.debug('Connected successfully to port: ' + str(nd_ref.options.port))
    else:
        logger.debug(" Connected successfully")

    # General settings to apply at connection time:
    nd_ref.machine.command("CU,3,1") # Enable data-low LED
    nd_ref.machine.command("CU,4,16") # Set FIFO depth of 16
    nd_ref.machine.command("CU,50,0") # Enable freewheeling of stepper motors

    return True


def query_voltage(nd_ref):
    """ Check that power supply is powered on at the moment. """
    if nd_ref.params.skip_voltage_check:
        return True
    if (nd_ref.machine.port is not None) and not nd_ref.options.preview:
        if not nd_ref.machine.query_voltage(200):
            nd_ref.warnings.add_new('voltage')

            if not nd_ref.plot_status.power:
                # Only update these status bits when we first see the power-lost flag.
                nd_ref.machine.var_write(0, 12) # Flag machine as not-homed
                nd_ref.machine.var_write(0, 13) # Write variable: Index 13 (power): Power lost
                nd_ref.machine.clear_steps()    # And, clear step counter
                nd_ref.plot_status.power = True

            return False
    return True


def read_status_byte(nd_ref):
    '''
    Special function to manage the `QG` status byte query and act upon any
    events reported in the response, such as a button press, limit switch touch,
    or loss of power.  Return status byte for other consumers.
    Bit 7: Limit switch
    Bit 6: Power lost flag
    Bit 5: Button press
    '''
    if nd_ref.options.preview:
        return None

    qg_val = nd_ref.machine.query_statusbyte()
    if nd_ref.machine.err is not None: # USB connectivity error.
        nd_ref.plot_status.connection = True # Flag for USB connection loss
        return None

    if qg_val is None: # Likely bad reading; ignore if only once...
        if nd_ref.plot_status.monitor:
            nd_ref.plot_status.connection = True # Flag this as a USB connection loss!
        nd_ref.plot_status.monitor = True # Flag that this happened, if just once.
        return None

    if qg_val & 128:                    # Limit switch flag
        nd_ref.plot_status.limit = True
    if qg_val & 32:                     # Button press flag
        nd_ref.plot_status.button = True
    if (qg_val & 64) and not nd_ref.params.skip_voltage_check: # Power loss flag
        if not nd_ref.plot_status.power:
            # Only update these status bits when we first see the power-lost flag.
            nd_ref.machine.var_write(0, 12) # Flag machine as not-homed
            nd_ref.machine.var_write(0, 13) # Write variable: Index 13 (power): Power lost
            nd_ref.machine.clear_steps()    # And, clear step counter
        nd_ref.plot_status.power = True

    return qg_val


def exhaust_queue(nd_ref):
    """
    Wait until queued motion commands have finished executing
    Uses the QG query http://evil-mad.github.io/EggBot/ebb.html#QG
    Uses time.sleep to sleep as long as motion commands are still executing.

    Query every 50 ms. Also break on keyboard interrupt (if configured) and
        pause button press.
    """

    if nd_ref.machine.port is None:
        return
    while True:

        if nd_ref.receive_pause_request(): # Keyboard interrupt detected!
            break

        qg_val = read_status_byte(nd_ref)
        if qg_val is None:
            return

        if ((qg_val & 15) == 0) or (nd_ref.plot_status.button):
            return # Motion complete or button pressed

        time.sleep(0.050) # Use "short" 50 ms intervals for responsiveness

def abs_move_wrapper(nd_ref, pos_1, pos_2, rate):
    """
    Wrapper function for ebb3_motion.abs_move; moves to specific (A,B) axis position
    at a given rate. Intended for very short correction moves only; 
    does not split motion into segments to monitor pause button.
    This is a "dog leg" move that does not necessarily move in a straight line.
    Use for absolute positioning only, not for drawing.
    """

    # nd_ref.user_message_fun(f"abs_move_wrapper: {pos_1}, {pos_2}.") # debug print
    if nd_ref.options.preview or (nd_ref.machine.port is None):
        return

    nd_ref.machine.abs_move(rate, int(pos_1), int(pos_2))


def enable_motors(nd_ref):
    """
    Enable motors, set native motor resolution, and set speed scales.
    The "pen down" speed scale is adjusted by reducing speed when using 8X microstepping or
    disabling acceleration. These factors prevent unexpected dramatic changes in speed when
    turning those two options on and off.
    """

    if nd_ref.use_layer_speed:
        local_speed_pendown = nd_ref.layer_speed_pendown
    else:
        local_speed_pendown = nd_ref.options.speed_pendown

    if not nd_ref.options.preview:
        read_status_byte(nd_ref)
        nd_ref.machine.command("CU,60,135") # Enable power monitoring, threshold 135 (~4 V).

        response = nd_ref.machine.motors_query_enabled()
        if response is None:
            return
        res_1, res_2 = nd_ref.machine.motors_query_enabled()

        read_status_byte(nd_ref) # Mainly to clear power status byte if it is set.
        if nd_ref.plot_status.power: # Power was lost sometime prior to calling this.
            nd_ref.machine.var_write(0, 12) # Write variable: Index 12 (homing): Not homed
            nd_ref.plot_status.power = False # Clear flag; we have acknowledged the power loss.

    if nd_ref.params.resolution == 1:  # High-resolution mode
        if not nd_ref.options.preview:
            if not (res_1 == 1 and res_2 == 1):     # Do not re-enable if already enabled
                nd_ref.machine.motors_enable(1, 1)  # Enable motors at 16X microstepping
                nd_ref.machine.var_write(0, 12)     # Flag machine as not-homed
                nd_ref.machine.clear_steps()  # Not technically needed; EM clears steps & accum.

        nd_ref.step_scale = 2.0 * nd_ref.params.native_res_factor
        nd_ref.speed_pendown = local_speed_pendown * nd_ref.params.speed_limit / 100.0
        nd_ref.speed_penup = nd_ref.options.speed_penup * nd_ref.params.speed_up / 100.0
    else:  # i.e., nd_ref.params.resolution == 2; Low-resolution mode
        if not nd_ref.options.preview:
            if not (res_1 == 2 and res_2 == 2):     # Do not re-enable if already enabled
                nd_ref.machine.motors_enable(2, 2)  # Enable motors at 16X microstepping
                nd_ref.machine.var_write(0, 12)     # Flag machine as not-homed
                nd_ref.machine.clear_steps()  # Not technically needed; EM clears steps & accum.

        nd_ref.step_scale = nd_ref.params.native_res_factor
        # Low-res mode: Allow faster pen-up moves. Keep maximum pen-down speed the same.
        nd_ref.speed_penup = nd_ref.options.speed_penup * nd_ref.params.speed_up / 100.0
        nd_ref.speed_pendown = local_speed_pendown * nd_ref.params.speed_limit / 100.0


def read_step_position(nd_ref):
    """ Return step position """
    if (nd_ref.machine.port is not None) and not nd_ref.options.preview:
        exhaust_queue(nd_ref)
        pos = nd_ref.machine.query_steps()
        if pos is None:
            return None
        return pos
    return None


def read_step_offsets(nd_ref):
    """ Read the to 32-bit motor-step offset values from the EBB. """
    if nd_ref.options.preview:
        return [0, 0]
    if nd_ref.machine.port is not None:
        offset_m1 = nd_ref.machine.var_read_int32(24)
        offset_m2 = nd_ref.machine.var_read_int32(28)
        offsets = [offset_m1, offset_m2]
        if None not in offsets:
            return offsets
    return None

def write_step_offsets(nd_ref, offset_1, offset_2):
    """ Write the to 32-bit motor-step offset values from the EBB. """
    if (nd_ref.machine.port is not None) and not nd_ref.options.preview:
        success_1 = nd_ref.machine.var_write_int32(offset_1, 24)
        success_2 = nd_ref.machine.var_write_int32(offset_2, 28)
        if False not in [success_1, success_2]:
            return True
    return False
