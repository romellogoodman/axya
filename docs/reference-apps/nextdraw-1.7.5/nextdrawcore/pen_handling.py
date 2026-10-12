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

'''
pen_handling.py

Classes for managing NextDraw pen vertical motion and status, plus keeping track
of overall XYZ pen position.

Part of the NextDraw driver software
http://bantamtools.com

The classes defined by this module are:

* PenPosition: Data storage class to hold XYZ pen position

* PenHandler: Main class for managing pen lifting, lowering, and status

* PenHeight: Manage pen-down height settings and keep timing up to date

* PenLiftTiming: Class to calculate and store pen lift timing settings

* PenStatus: Data storage class for pen lift status variables

'''
import time
from nextdrawcore import serial_utils
from nextdrawcore.plot_utils_import import from_dependency_import # plotink
plot_utils = from_dependency_import('plotink.plot_utils')
# inkex = from_dependency_import('ink_extensions.inkex')

class PenPosition:
    ''' PenPosition: Class to store XYZ position of pen '''

    def __init__(self):
        self.xpos = 0 # X coordinate
        self.ypos = 0 # Y coordinate
        self.z_up = None # Initialize as None: state unknown.
        self.accum1 = 0
        self.accum2 = 0
        self.homed = False

    def reset(self):
        ''' Reset XYZ positions to default. '''
        self.xpos = 0
        self.ypos = 0
        self.z_up = None
        self.accum1 = 0
        self.accum2 = 0
        self.homed = False

    def reset_z(self):
        ''' Reset Z position only. '''
        self.z_up = None


class PenHeight:
    '''
    PenHeight: Class to manage pen-down height settings.
    Calculate timing for transiting between pen-up and pen-down states.
    '''

    def __init__(self):
        self.pen_pos_down = None # Initial values must be set by update().
        self.use_temp_pen_height = False # Boolean set true while using temporary value
        self.times = PenLiftTiming()

    def update(self, nd_ref):
        '''
        Set initial/default values of options, after __init__.
        Call this function after changing option values to update pen height settings.
        '''
        if not self.use_temp_pen_height:
            self.pen_pos_down = nd_ref.options.pen_pos_down
        self.times.update(nd_ref, self.pen_pos_down)

        nd_ref.pen.status.init_goal[0] = nd_ref.options.pen_pos_up
        nd_ref.pen.status.init_goal[1] = self.pen_pos_down


    def set_temp_height(self, nd_ref, temp_height):
        '''
        Begin using temporary pen height position. Return True if the position has changed.
        '''
        self.use_temp_pen_height = True
        if self.pen_pos_down == temp_height:
            return False
        self.pen_pos_down = temp_height

        self.times.update(nd_ref, temp_height)
        return True

    def end_temp_height(self, nd_ref):
        '''
        End using temporary pen height position. Return True if the position has changed.
        '''
        self.use_temp_pen_height = False
        if self.pen_pos_down == nd_ref.options.pen_pos_down:
            return False
        self.pen_pos_down = nd_ref.options.pen_pos_down
        self.times.update(nd_ref, self.pen_pos_down)
        return True


class PenLiftTiming: # pylint: disable=too-few-public-methods
    '''
    PenTiming: Class to calculate and store time required for pen to lift and lower
    '''

    def __init__(self):
        self.raise_time = None
        self.lower_time = None

    def update(self, nd_ref, pen_down_pos):
        '''
        Compute travel time needed for raising and lowering the pen.

        Call this function after changing option values to update pen timing settings.

        Servo travel time is estimated as the 4th power average (a smooth blend between):
          (A) Servo transit time for fast servo sweeps (t = slope * v_dist + min) and
          (B) Sweep time for slow sweeps (t = v_dist * full_scale_sweep_time / sweep_rate)
        '''
        v_dist = abs(float(nd_ref.options.pen_pos_up - pen_down_pos))

        servo_move_slope = nd_ref.params.servo_move_slope
        servo_move_min = nd_ref.params.servo_move_min
        servo_sweep_time = nd_ref.params.servo_sweep_time

        # Raising time:
        v_time = int(((servo_move_slope * v_dist + servo_move_min) ** 4 +
            (servo_sweep_time * v_dist / nd_ref.options.pen_rate_raise) ** 4) ** 0.25)
        if v_dist < 0.9:  # If up and down positions are equal, no initial delay
            v_time = 0

        v_time += nd_ref.params.pen_delay_up
        v_time = max(0, v_time)  # Do not allow negative total delay time
        self.raise_time = v_time

        # Lowering time:
        v_time = int(((servo_move_slope * v_dist + servo_move_min) ** 4 +
            (servo_sweep_time * v_dist / nd_ref.options.pen_rate_lower) ** 4) ** 0.25)
        if v_dist < 0.9:  # If up and down positions are equal, no initial delay
            v_time = 0
        v_time += nd_ref.params.pen_delay_down
        v_time = max(0, v_time)  # Do not allow negative total delay time
        self.lower_time = v_time


class PenStatus:
    '''
    PenTiming: Data storage class for pen lift status variables

    preview_pen_state: pen state for preview rendering. 0: down, 1: up, -1: changed
    lifts: Counter; keeps track of the number of times the pen is lifted
    state/goal: List of last [pen_pos_up, pen_pos_down, z_motor (type), pen_up],
            which is used to during initialization only, to record the desired servo
            state and compare it to the actual servo state.
    '''

    def __init__(self):
        self.preview_pen_state = -1 # Will be moved to preview.py in the future
        self.lifts = 0
        self.init_state = [-1, -1, -1, None] # [pen_pos_up, pen_pos_down, z_motor, pen_up]
        self.init_goal = [-1, -1, -1, None]  # [pen_pos_up, pen_pos_down, z_motor, pen_up]

    def reset(self):
        ''' Clear preview pen state and lift count; Resetting them for a new plot. '''
        self.preview_pen_state = -1  # Will be moved to preview.py in the future
        self.lifts = 0

    def report(self, nd_ref, message_fun):
        ''' report: Print pen lift statistics '''
        if not (nd_ref.options.report_time and nd_ref.params.report_lifts):
            return
        message_fun(f"Number of pen lifts: {self.lifts}\n")


class PenHandler:
    '''
    PenHandler: Main class for managing pen lifting, lowering, and status,
    plus keeping track of XYZ pen position.
    '''

    def __init__(self):
        self.heights = PenHeight()
        self.status  = PenStatus()
        self.phys    = PenPosition() # Physical XYZ pen position
        self.turtle  = PenPosition() # turtle XYZ pen position, for interactive control

    def reset(self):
        '''
        Reset certain defaults for a new plot:
        Clear pen height and lift count; clear temporary pen height flag.
        These are the defaults that can be set even before options are set.
        '''
        self.status.reset()
        self.heights.use_temp_pen_height = False

    def pen_raise(self, nd_ref):
        ''' Raise the pen '''

        self.status.preview_pen_state = -1 # For preview rendering use

        # Skip if physical pen is already up:
        if self.phys.z_up:
            return

        self.status.lifts += 1

        v_time = self.heights.times.raise_time
        servo_pin = nd_ref.params.servo_pin

        if nd_ref.options.preview:
            nd_ref.preview.v_chart.rest(nd_ref, v_time)
        else:
            nd_ref.machine.pen_raise(v_time, servo_pin)
            if (v_time > 50) and (nd_ref.options.mode not in\
                ["utility", "align", "cycle"]):
                time.sleep(float(v_time - 30) / 1000.0) # pause before issuing next command
            if nd_ref.params.use_b3_out: # I/O Pin B3 output: low
                if nd_ref.params.sync_b3: # Add sync delays when using B3
                    serial_utils.exhaust_queue(nd_ref) # Delay to exhaust motion control queue
                nd_ref.machine.dio_b_set(3, 0)  # Function needs test
        self.phys.z_up = True


    def pen_lower(self, nd_ref):
        ''' Lower the pen '''

        self.status.preview_pen_state = -1  # For preview rendering use
        if self.phys.z_up is not None:
            if not self.phys.z_up:
                return # skip if pen is state is _known_ and is down

        # Skip if stopped:
        if nd_ref.plot_status.stopped:
            return

        v_time = self.heights.times.lower_time

        servo_pin = nd_ref.params.servo_pin

        if nd_ref.options.preview:
            nd_ref.preview.v_chart.rest(nd_ref, v_time)
        else:
            nd_ref.machine.pen_lower(v_time, servo_pin)
            if (v_time > 50) and (nd_ref.options.mode not in\
                ["utility", "align", "cycle"]):
                time.sleep(float(v_time - 30) / 1000.0) # pause before issuing next command
            if nd_ref.params.use_b3_out: # I/O Pin B3 output: high
                if nd_ref.params.sync_b3: # Add sync delays when using B3
                    serial_utils.exhaust_queue(nd_ref) # Delay to exhaust motion control queue
                nd_ref.machine.dio_b_set(3, 1)  # Function needs test
        self.phys.z_up = False

    def cycle(self, nd_ref):
        '''
        Toggle the pen down and then up, with a 1/2 second delay.
        Call only after servo_init(), which lowers the pen when initializing.
        This function should only be used as a setup utility.
        '''
        self.pen_lower(nd_ref) # Explicitly lower pen if necessary.
        nd_ref.machine.timed_pause(500)
        self.pen_raise(nd_ref)

    def set_temp_height(self, nd_ref, temp_height):
        '''Begin using temporary pen height position'''
        if self.heights.set_temp_height(nd_ref, temp_height):
            self.servo_init(nd_ref)

    def end_temp_height(self, nd_ref):
        '''End use of temporary pen height position'''
        if self.heights.end_temp_height(nd_ref):
            self.servo_init(nd_ref)

    def find_pen_state(self, nd_ref):
        '''
        Determine whether EBB pen heights are initialized, and if so, how so.
        Populate self.init_state with [pen_pos_up, pen_pos_down, z_motor, pen_up],
            as read from the EBB, where:
        * pen_pos_up and pen_pos_down are in range of 0-100
            IF they were initialized and -1 if not.
        * z_motor is 1 if we are currently configured for brushless pen-lift
            (nd_ref.params.z_motor == 1) AND both pen_pos_up and pen_pos_down
            read out as initialized for brushless. 
        * z_motor is 0 if we are currently configured for legacy pen-lift
            (nd_ref.params.z_motor == 0) AND both pen_pos_up and pen_pos_down
            read out as initialized for legacy pen lift.
        * z_motor is 0 otherwise.
        * pen_up is 1 if EBB thinks pen is up.
        '''

        code_up_read = nd_ref.machine.var_read(10)
        code_down_read = nd_ref.machine.var_read(11)

        if code_up_read is None or code_down_read is None:
            self.status.init_state[0] = -1 # Flag as "not initialized."
            self.status.init_state[1] = -1
            return

        if nd_ref.params.z_motor:
            if ((code_up_read > 101) and (code_down_read > 101)):
                # Both readings indicate correctly configured for brushless pen-lift motor.
                self.status.init_state[2] = 1
        elif (code_up_read < 102) and (code_down_read < 102):
            # Both readings indicate correctly configured for legacy pen-lift motor.
            self.status.init_state[2] = 0

        if code_up_read == 0:
            self.status.init_state[0] = -1  # Flag as "not initialized."
        elif code_up_read > 101:                            # For brushless motor
            self.status.init_state[0] = code_up_read - 102  # Maps 102 - 202 -> 0 - 100
        else:                                               # For legacy motor
            self.status.init_state[0] = code_up_read - 1    # Maps 1 - 101 -> 0 - 100

        if code_down_read == 0:
            self.status.init_state[1] = -1  # Flag as "not initialized."
        elif code_down_read > 101:                              # For brushless motor
            self.status.init_state[1] = code_down_read - 102    # Maps 102 - 202 -> 0 - 100
        else:                                                   # For legacy motor
            self.status.init_state[1] = code_down_read - 1      # Maps 1 - 101 -> 0 - 100

        # Does EBB think pen is up?
        try:
            self.status.init_state[3] = bool(serial_utils.read_status_byte(nd_ref) & 16)
        except TypeError:                       # One-time error in reading...
            self.status.init_state[3] = True    # Assume pen up, without further information.

    def servo_init(self, nd_ref):
        '''
        Utility function, used for setting or updating the various parameters that control
        the pen-lift servo motor. 

        Actions:
        1. If current pen up/down state is not yet known, query EBB to see if it has
            been initialized, or whether it is still in its default power-on state.
        2. Send EBB commands to set servo positions, lifting/lowering speeds,
            PWM channel count, timeout, and standard or narrow-band servo output.
        3. Put the servo into a known/desired state, if necessary,
            by sending a pen-lift or pen-lower command. 

        Methods:
        When the EBB is reset, it goes to its default "pen up" position. The EBB may
        will tell us that the in the pen-up state. However, its actual position is the
        default, not the pen-up position that we've requested.

        To fix this, we could manually command the pen to either the pen-up or pen-down
        position. HOWEVER, that may take as much as five seconds in the very slowest
        speeds, and we want to skip that delay if the pen is already in the right place,
        for example if we're plotting after raising the pen, or plotting twice in a row.

        Solution: Store pen-up/pen-down config in EBB firmware variables that are set to
        zero upon reset.

        For changes after initialization, we use a list that encodes the pen-up, pen-down and
        narrow-band settings. If (e.g.,) the pen-down height has changed while the pen is down,
        (e.g., Python interactive API update()), move to the new position.
        '''

        self.heights.update(nd_ref) # Ensure heights and transit times are known
        if nd_ref.options.preview:
            self.phys.z_up = True
        if nd_ref.options.preview or (nd_ref.machine.port is None):
            return

        # Desired positions
        code_up = 1 + nd_ref.options.pen_pos_up    # Allowed range 1 - 101.
        code_down = 1 + self.heights.pen_pos_down  # Allowed range 1 - 101.

        self.status.init_goal[0] = nd_ref.options.pen_pos_up
        self.status.init_goal[1] = self.heights.pen_pos_down

        if nd_ref.params.z_motor:
            pwm_period = 0.03       # Units are "ms / 100", since pen_rate_raise is a %.
            self.status.init_goal[2] = 1   # Note brushless pen-lift motor
            code_up += 101          # Allowed range: 102-202
            code_down += 101        # Allowed range: 102-202
        else:
            pwm_period = 0.24       # 24 ms: 8 channels at 3 ms each (divided by 100 as above)
            self.status.init_goal[2] = 0   # Note legacy pen-lift motor

        self.find_pen_state(nd_ref) # populates self.status.init_state

        # Determine if pen-lift servo is initialized w/ current pen-up/down & servo type:
        servo_initialized = ((self.status.init_state[0] == self.status.init_goal[0]) and\
                             (self.status.init_state[1] == self.status.init_goal[1]) and\
                             (self.status.init_state[2] == self.status.init_goal[2]))

        # If the servo is properly initialized, leave it alone at init as a default.
        if servo_initialized:
            self.phys.z_up = self.status.init_state[3]
            self.status.init_goal[3] = self.status.init_state[3] # Leave pen where it is.

        # Special cases: The pen should go *down* when first initialized
        if (nd_ref.options.mode =="utility" and nd_ref.options.utility_cmd =="lower_pen") or\
                (nd_ref.options.mode =="toggle" and bool(self.phys.z_up)) or\
                nd_ref.options.mode =="cycle":
            self.status.init_goal[3] = False # Goal should be to initially lower pen.

        # Special cases: The pen should go *up* when first initialized.
        # This includes the uninitialized case. Raising the pen is a reasonable
        #   default action when both (1) the servo is NOT initialized and
        #   (2) we're not explicitly in a mode where we lowers it first.
        elif (not servo_initialized) or (nd_ref.options.mode =="toggle") or\
            (nd_ref.options.mode =="utility" and nd_ref.options.utility_cmd =="raise_pen"):
            self.status.init_goal[3] = True # Goal should be to initially raise pen.

        servo_min = nd_ref.params.servo_min
        servo_pin = nd_ref.params.servo_pin

        servo_range =  nd_ref.params.servo_max - servo_min
        servo_slope = float(servo_range) / 100.0

        servo_rate_scale = float(servo_range) * pwm_period / nd_ref.params.servo_sweep_time

        nd_ref.machine.pen_rate_up(\
            int(round(servo_rate_scale * nd_ref.options.pen_rate_raise)))
        nd_ref.machine.pen_rate_down(\
            int(round(servo_rate_scale * nd_ref.options.pen_rate_lower)))

        if nd_ref.params.use_b3_out:  # Configure I/O Pin B3 for use
            nd_ref.machine.dio_b_config(3, 0, 0) # output, low

        nd_ref.machine.pen_pos_up(\
            int(round(servo_min + servo_slope * nd_ref.options.pen_pos_up)))
        nd_ref.machine.pen_pos_down(\
            int(round(servo_min + servo_slope * self.heights.pen_pos_down)))

        if servo_initialized and (self.phys.z_up is not None):
            if self.phys.z_up == self.status.init_goal[3]:
                return # Servo initialized. Don't perform lifting/lowering.

        if not self.status.init_goal[3]: # Pen lowering requested
            v_time = self.heights.times.lower_time
            nd_ref.machine.pen_lower(v_time, servo_pin)
            if nd_ref.params.use_b3_out: # I/O Pin B3 output: high
                nd_ref.machine.dio_b_set(3, 1)  # Function needs test
            self.phys.z_up = False

        if  self.status.init_goal[3]: # Pen raising requested
            v_time = self.heights.times.raise_time
            nd_ref.machine.pen_raise(v_time, servo_pin)
            if nd_ref.params.use_b3_out: # I/O Pin B3 output: low
                nd_ref.machine.dio_b_set(3, 0) # Function needs test
            self.phys.z_up = True

        if nd_ref.params.z_motor:
            nd_ref.machine.command('SC,8,1') # 1 channel of servo PWM
        else:
            nd_ref.machine.command('SC,8,8') # 8 channel of servo PWM
            # Power timeout is only applicable to legacy servo:
            nd_ref.machine.servo_timeout( nd_ref.params.servo_timeout, None)

        self.status.init_state = self.status.init_goal.copy() # Save updated params

        nd_ref.machine.var_write(code_up, 10)   # Save encoded pen-up position
        nd_ref.machine.var_write(code_down, 11) # Save encoded pen-down position


    def servo_revert(self, nd_ref):
        '''
        Utility function, to "revert" settings after pausing a plot. When we pause,
        we use the "SP,3" command to raise the pen urgently AND set the pen-down
        height equal to the pen-up height. To be good citizens, we should also,
        once things are safe, set the pen-down height back where it was.
        '''

        if self.phys.z_up is None: # Require that servo is initialized
            return

        self.heights.update(nd_ref) # Ensure heights and transit times are known
        servo_min = nd_ref.params.servo_min
        servo_range =  nd_ref.params.servo_max - servo_min
        servo_slope = float(servo_range) / 100.0

        serial_utils.exhaust_queue(nd_ref) # Wait until pen moves have completed.

        nd_ref.machine.pen_pos_down(\
            int(round(servo_min + servo_slope * self.heights.pen_pos_down)))
