'''
homing.py

Homing functions for NextDraw. (Not supported on legacy models.)

Copyright 2025 Windell H. Oskay, Bantam Tools

The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

'''
import time   # time.sleep function is used
from nextdrawcore import serial_utils
from nextdrawcore.plot_utils_import import from_dependency_import    # plotink
plot_utils = from_dependency_import('plotink.plot_utils')


def xy_to_step_pos(nd_ref, x_in, y_in):
    '''
    Find and return the absolute (A, B) step position corresponding to a given
    (X, Y) position in inches.
    Inputs x_in, y_in are in inches
    '''

    if nd_ref.params.resolution == 2:   # Low-resolution mode
        x_in /= 2
        y_in /= 2

    a_steps = round((2 * nd_ref.params.native_res_factor) * (x_in + y_in))
    b_steps = round((2 * nd_ref.params.native_res_factor) * (x_in - y_in))

    return (a_steps, b_steps)


def steps_to_xy_pos(nd_ref, a_steps, b_steps):
    '''
    Find and return the (X, Y) carriage position in inches, corresponding to a given
    (A, B) motor step position.
    Inputs a_steps, b_steps are integer step positions.
    '''

    x_pos = (a_steps + b_steps) / (4 * nd_ref.params.native_res_factor)
    y_pos = (a_steps - b_steps) / (4 * nd_ref.params.native_res_factor)

    if nd_ref.params.resolution == 2:   # Low-resolution mode
        x_pos *= 2
        y_pos *= 2

    return (x_pos, y_pos)


class HomingClass:
    ''' Class to manage homing functions '''   # pylint: disable = pointless-string-statement

    SPEED_FAST = 2    # inches per second, coarse speed
    SPEED_FINE = .25    # inches per second
    SPEED_SLOW = .1    # inches per second
    SIDE_DIST = 6    # Step off 6 mm x 6 mm before moving back.

    def __init__(self, nd_ref=None, user_message_fun=None):
        self.failed = False   # Homing has failed
        self.paused = False   # Homing was paused
        self.step_scale = None
        self.nd_ref = nd_ref
        self.message_fun = user_message_fun
        self.speed_fine = HomingClass.SPEED_FINE
        self.res = 0   # Resolution value, 1: High, 2: Low

    def find_home(self):
        '''
        Main homing function.
        If the machine is connected and we are not in preview mode:
            If automatic homing is enabled:
                Run the automatic homing routine
            else:
                Essentially, pretend that we did.
            Finally, set the step position to 0 and tell the machine it is homed.
        '''

        if self.nd_ref.options.preview:
            return True

        do_auto_homing = self.nd_ref.options.homing and self.nd_ref.params.auto_home

        if (self.nd_ref.machine.port is None) or (self.nd_ref.machine.err is not None):
            self.mark_failed()
            return False

        if self.nd_ref.machine.var_read(12):    # Read machine state: is it already fully homed?
            self.read_position()    # Already homed! Set xpos, ypos values
            return True

        if do_auto_homing:
            if 'voltage' in self.nd_ref.warnings.warning_dict:
                self.nd_ref.warnings.add_new('homing_voltage')
                self.mark_failed()   # Fail quickly and correctly if we do not have power.
                return False
            if self.nd_ref.params.skip_voltage_check:  # Special case; Auto-homing needs power!
                if not self.nd_ref.machine.query_voltage(200):
                    self.nd_ref.warnings.add_new('homing_voltage')
                    self.mark_failed()   # Fail quickly and correctly if we do not have power.
                    return False

            self.step_scale = self.nd_ref.step_scale

            if self.nd_ref.params.resolution == 1:   # High-resolution mode
                self.res = 1
            else:   # i.e., nd_ref.params.resolution == 2; Low-resolution mode
                self.res = 2

            self.rhm_homing()    # Homing of Right-Hand Motor (RHM); Gets close on LHM, too.
            if self.failed:
                self.mark_failed()
                return False
            self.nd_ref.machine.clear_steps()
            self.lhm_homing()

        if self.failed:
            self.mark_failed()
            return False    # Clear step counters and set the bits that mark the machine as homed:
        self.set_home()
        return True

    def mark_failed(self):
        ''' Housekeeping after homing sequence fails '''
        self.failed = True
        if self.nd_ref.plot_status.stopped == 0:    # Only if no other error is present:

            if 'voltage' in self.nd_ref.warnings.warning_dict:    # Power loss is likely issue!
                self.nd_ref.plot_status.stopped = 105    # Add code for power loss
            else:
                self.nd_ref.plot_status.stopped = 106    # Add code for homing failed

        if (self.nd_ref.machine.port is None) or (self.nd_ref.machine.err is not None):
            return

        self.nd_ref.machine.var_write(0, 12)    # Mark machine as not-homed.

    def block(self, timeout_ms=None):
        '''
        Wait until all motion control commands have finished, an
        an optional timeout occurs, or the button has been pressed.
        Uses "E-stop" feature to stop movement as soon as button press detected, so that
            the user may interrupt a homing sequence in process.

        Polls the EBB immediately and then every 10 ms thereafter until (1) Neither motor is
        currently in motion and (2) there is no queued motion control command.

        A value for timeout_ms, gives the maximum duration to wait in milliseconds.

        (Notably different from serial_utils.exhaust_queue,
            which does not have a timeout or ES function.)
        '''

        if self.failed:
            return

        if timeout_ms is None:
            time_left = 1000   # Default timeout value: 1 second
        else:
            time_left = timeout_ms

        while True:
            qg_val = serial_utils.read_status_byte(self.nd_ref)

            if self.nd_ref.plot_status.button:
                self.message_fun("Homing interrupted by button press.")
                self.paused = True
                self.failed = True
                self.nd_ref.machine.query('ES')    # "E-stop" -- end movement.
                return

            if (qg_val & 15) == 0:    # Motion status bit indicate no motion
                return
            if time_left <= 0:
                self.failed = True
                self.message_fun("Timeout at block function in homing routine.")
                return
            if time_left < 10:
                time.sleep(time_left / 1000)    # Use up remaining time
                time_left = 0
            else:
                time.sleep(0.002)    # Sleep 2 ms
                if timeout_ms is not None:
                    time_left -= 2

    def query_limit_switch(self):
        '''
            Wait for any existing motion commands to finish, then query limit switch.
            Normally-closed limit switch connects pin B1 to ground when not pressed.
            Return 1 if limit switch port reading is 1 (switch pressed or not present)
            Return 0 if limit switch port reading is 0 (switch present; not pressed)
            Return 2 on error
        '''
        if (self.nd_ref.machine.port is None) or (self.nd_ref.machine.err is not None):
            return 2

        self.block()    # Exhaust motion queue.

        response = self.nd_ref.machine.dio_b_read(1)

        if response is None:
            self.message_fun("Error reading serial data in Homing process.")
            self.failed = True
            return 2
        if response:
            return 1
        return 0

    def move_xy_inch(self, x_inches, y_inches, time_ms):
        ''' Simplified XY move command '''

        if self.failed or self.paused:
            return

        delta_x_inches = x_inches
        delta_y_inches = y_inches
        motor_dist1 = delta_x_inches + delta_y_inches    # Inches that belt must turn at Motor 1
        motor_dist2 = delta_x_inches - delta_y_inches    # Inches that belt must turn at Motor 2

        motor_steps1 = int(round(self.step_scale * motor_dist1))    # Round to nearest motor step
        motor_steps2 = int(round(self.step_scale * motor_dist2))    # Round to nearest motor step

        self.nd_ref.machine.xy_move(motor_steps2, motor_steps1, time_ms)

    def left_until_bump(self, speed, max_dist):
        '''
        Move left until limit switch is bumped.
        Turns off left-hand motor to do so.

        Speed is in inches per second
        max_dist is maximum distance to travel, inches.

        return apparent distance traveled (inches), or -1 if limit not detected.
        '''

        if self.failed or self.paused:
            self.failed = True
            return -1

        if self.query_limit_switch() == 1:    # Switch is down; cannot begin leftward move
            self.failed = True
            self.message_fun("Automatic homing failed. (Error: Limit switch not ready.)")
            return -1

        if 'voltage' in self.nd_ref.warnings.warning_dict:
            self.nd_ref.warnings.add_new('homing_voltage')
            return -1    # Error condition; low voltage, overriding basic voltage warning.

        self.block()    # Wait for move to finish
        # Disable M2 (left-hand motor) & clear step count:
        self.nd_ref.machine.motors_enable(self.res, 0)
        self.block()    # Wait for move to finish

        self.enable_limit_detection()

        time_ms = abs(int(1000 * max_dist / speed))

        self.move_xy_inch(-max_dist, 0, time_ms)    # "Move left by a certain distance".
        # The actual move will be diagonal towards home, not left, until Y = 0.
        # Distance traveled will be *half* of expected distance until Y = 0.
        # Once Y = 0, will travel at expected distance per motor step.

        self.block()    # Wait for move to finish
        limit_occurred = self.nd_ref.plot_status.limit
        self.nd_ref.machine.command("CU,51,0")    # Disable limit switch detection

        if not limit_occurred and not self.paused:
            self.failed = True
            self.message_fun('Automatic homing failed with a "limit not found" error.\n\n' +
                             'This could indicate that you have the wrong plotter selected.\n' +
                             'You are presently configured for the ' +
                             f'{self.nd_ref.params.model_name}.')
            return -1    # Error condition; maximum distance traveled
        # Note that step position was cleared (by EM) before the last movement; step position
        # away from zero represents the step count of the previous move only.

        return abs(self.nd_ref.machine.query_steps()[1] / self.step_scale)

    def back_off_plus_x(self, speed):
        '''
        Preface a move by "backing off" to the right and back (6 mm right, left 3.5),
            with both motors on. If the previous move were to the left, then this should
            end up positioned 2.5 mm to the right of the previous position.
        Speed is in inches per second.
        '''
        if self.failed or self.paused:
            return

        self.nd_ref.machine.motors_enable(self.res, self.res)    # Enable both motors
        # move right by 6 mm
        step_size = 6/25.4    # Convert to inches...
        self.move_xy_inch(step_size, 0, int(1000 * abs(step_size / speed)))

        if self.query_limit_switch() == 1:    # Switch still pressed OR not present at all.
            self.failed = True
            self.message_fun("Automatic homing failed.\n" +
                             "(Error: Limit switch not detected. " +
                             "Is your model selected correctly?)")
            return    # move left by 2.5 mm -- leaving us 2.5 mm from home, assuming no hysteresis
        step_size = 3.5/25.4    # Convert to inches...
        self.move_xy_inch(-step_size, 0, int(1000 * abs(step_size / speed)))

        if self.query_limit_switch() == 1:    # Switch activated too early. :(
            self.failed = True
            self.message_fun("Automatic homing failed. (Error: Limit switch position error.)")

    def rhm_homing_fine(self):
        ''' Back off to right and move left until limit. '''
        if self.failed or self.paused:
            return -1

        left_coarse_dist = 7    # Left-moving moves limited to 7 mm.

        '''
        Preface a move by "backing off" to the right and back (6 mm right, left 3.5),
            with both motors on. If the previous move were to the left, then this should
            end up positioned 2.5 mm to the right of the previous position.
        Speed is in inches per second.
        '''

        if self.failed or self.paused:
            return -1

        self.nd_ref.machine.motors_enable(self.res, self.res)    # Enable both motors

        step_size = 6/25.4    # move right by 6 mm

        self.move_xy_inch(step_size, 0, int(1000 * abs(step_size / HomingClass.SPEED_FAST)))

        if self.query_limit_switch() == 1:    # Switch still open; Likely no limit switch
            self.failed = True
            self.message_fun("Automatic homing failed. (Error: Limit switch not detected.)")
            return -1  # move left by 3.5 mm, leaving us 2.5 mm from home (ignoring hysteresis)
        step_size = (left_coarse_dist / 2) / 25.4    # Convert to inches...

        self.move_xy_inch(-step_size, 0, int(1000 * abs(step_size / HomingClass.SPEED_FAST)))

        if self.query_limit_switch() == 1:    # Switch activated too early. :(
            self.failed = True
            self.message_fun("Automatic homing failed. (Error: Limit switch position error.)")

        if self.failed:
            return -1   # Fine move to left, typ 7 mm max:
        dist = self.left_until_bump(self.speed_fine, left_coarse_dist/25.4)
        return dist

    def rhm_homing(self):
        ''' Main function of auto-homing feature.

        --- HOMING STAGE 1 ---
        With our normally-closed limit switch, check to see if the switch is closed.

            Query switch with query_limit_switch().

            If query_limit_switch() returned 1: Switch pressed or not present
                1A: * Move off to right, small distance. Verify that switch is not pressed.
                        - If fail to verify switch present, error ("Limit switch error")
            Else: query_limit_switch() returned 0: Switch not pressed
                1B: * Coarse move to left with RHM only until button press.
                        - Keep track of "apparent" distance moved.
                        - If fail to press after distance, error. ("Coarse Limit not found")
                    * Move off to right, small distance. Verify that switch is not pressed.
                        - If fail to verify switch present, error. ("Limit switch error")
            Then:
                1C: Make fine move to left (right-hand motor only) until button press.
                        - If fail to press after distance, error. ("Fine Limit 1 not found")

            At this point, the carriage is up against the limit switch, having moved left with
                fine homing steps into the "first calibrated position".

        --- HOMING STAGE 2 ---
            2A: Make a calibrated move to the right, maybe 1 cm with both motors.
                - If fail to verify switch present, error ("Limit switch error 3")
            2B: Fine move to left until limit switch.
                - Keep track of "apparent" distance moved.
                - If fail to press after distance, error. ("Fine Limit 2 not found")

            If distance moved indicates that Y = 0:
                Calibration is complete. Clear position to zero and exit.

            2C: If distance moved indicates that Y is not zero but is *very small*:
                Back off and re-zero again.
                Calibration is complete. Clear position to zero and exit.

        --- HOMING STAGE 3 ---
            3A: Large coarse move to right.
                - Limit by apparent distance moved thus far, and maximum travel of model.
                - If fail to verify switch present, exit with error. ("Limit switch error 4")
            3B: * Coarse move to left with RHM only until button press.
                - If fail to press after distance, exit with error. ("Coarse Limit not found")
            3C: Make a calibrated move to the right, maybe 1 cm with both motors.
                - If fail to verify switch present, exit with error ("Limit switch error 5")
            3D: Fine move to left until limit switch.
                - Keep track of "apparent" distance moved.
                - If fail to press after distance, exit with error. ("Fine Limit 3 not found")

            If distance moved indicates that Y = 0:
                Calibration is complete. Clear position to zero and exit.
            Else: Exit with error.
        '''

        [x_max, y_max] = self.nd_ref.bounds[1]   # Positive travel limits

        self.nd_ref.machine.dio_b_config(1, 1, 1)   # Pin B1 as input, initially high.
        self.nd_ref.machine.command("CU,50,0")   # Enable freewheeling of stepper motors

        if self.query_limit_switch() == 1:   # Limit switch appears to be actuated. Stage 1A.

            first_coarse_dist = 0.05  # Limit switch is already down; Skip the first coarse move.
        else:   # Stage 1B: Coarse move left until bump
            # Maximum travel distance for initial coarse move:
            # Twice X-distance along diagonal (moves at half speed with only one motor)
            # plus possible additional X travel, (X_max - Y_max):

            max_dist = 2 * y_max + (x_max - y_max)   # inches
            max_dist += 0.5   # Allow extra travel for minor variations in machine configuration

            coarse_dist_apparent = self.left_until_bump(HomingClass.SPEED_FAST, max_dist)

            if self.failed:
                return
            # Because we're driving with one motor, the distance that we read out is twice
            # the actual distance that the motor has moved, IF we are not yet at Y = 0.
            first_coarse_dist = coarse_dist_apparent / 2

        dist = self.rhm_homing_fine()   # If Y = 0, result should be 2.5 mm ~= 0.0984 in

        if self.failed:   # Error in first stage of homing
            return

        first_dist_close = False
        if dist < 0.15:
            first_dist_close = True
        # Stage 2: Calibrated move to right, then fine move until limit.
        dist = self.rhm_homing_fine()

        if dist < 0:
            self.failed = True   # Error; limit not found (2B)
            return

        if dist <= 0.0984:   # Nominal 0.0984 -- 2.5 mm -- is the goal
            return   # Zeroed (first try)

        if first_dist_close and (dist < 0.12):
            return   # Zeroed (first try, part B)

        if dist < 0.15:   # Stage 2C
            dist2 = self.rhm_homing_fine()

            if dist2 > 0.12:
                self.failed = True
                self.message_fun("Homing failed")   # Inconsistent or too-large final position.
                return
            return   # "Zeroed (2nd try)"
        # Otherwise, go to Stage 3.
        # Not close to zero; try a large move right. Exact distance TBD.
        # Find maximum travel distance for secondary coarse move:
        # Maximum possible travel is y_max - first_coarse_dist
        # We back off by that distance, and then set the maximum travel to *twice that*, for the
        # second coarse move, which (until Y = 0) travels at only 1/2 the requested distance.

        remaining_distance = y_max - first_coarse_dist
        remaining_distance -= 2.5/25.4   # Subtract 2.5 mm for the movement in initial zeroing.

        remaining_distance = max(remaining_distance, 0)

        right_move_dist = remaining_distance   # Big move right:
        self.nd_ref.machine.motors_enable(self.res, self.res)   # Enable both motors

        self.move_xy_inch(remaining_distance, 0,
                          int(1000 * remaining_distance / HomingClass.SPEED_FAST))
        # Allow an extra 0.1 inches for minor variations in (e.g.) limit switch position.
        max_dist = 2 * (right_move_dist + 0.1)   # Multiply by 2, for apparent movement distance

        coarse_dist = self.left_until_bump(HomingClass.SPEED_FAST, max_dist)

        if coarse_dist < 0:
            self.message_fun("Error: Homing failed at second coarse move; no limit found.")
            self.failed = True
            return

        dist = self.rhm_homing_fine()   # Move left until fine bump

        if dist < 0:
            self.message_fun("Error; limit not found")
            return

        if dist <= 0.0984:   # Nominal 0.0984 is the goal
            return   # Zeroed (first try after secondary move)
        if dist < 0.15:
            dist2 = self.rhm_homing_fine()

            if dist2 > 0.12:
                self.message_fun("Error: Homing failed (not found; secondary)")
                self.failed = True
                return   # Consistent position, but not identical to nominal. (No worries.)

    def lhm_homing(self):
        '''
        Secondary homing for precision.
        Procedure: Start with the RHM zeroed.
            Enable both motors. Step out (6, 6) mm in the X+Y direction, away from Home, via RHM.
            Step in the -X+Y direction, with a nominal move of (-12,12) mm, until the limit
                switch activates. The first part of this (-3.5, 3.5) mm at fast speed, the second
                part slow at fine speed.
            Record the LHM (motor 2) position that caused the limit switch to activate.
            Walk back that many steps on LHM, and walk back to origin on RHM as well.
        '''

        self.nd_ref.machine.motors_enable(self.res, self.res)   # Enable both motors

        step_size = HomingClass.SIDE_DIST/25.4   # Convert to inches...
        motor_dist1 = step_size + step_size
        motor_steps1 = int(round(self.step_scale * motor_dist1))    # Round to nearest motor step

        time_ms = int(1000 * abs(step_size / HomingClass.SPEED_FAST))

        self.nd_ref.machine.xy_move(0, motor_steps1, time_ms)
        # Do first half of leftward move at higher speed.
        step_size = (HomingClass.SIDE_DIST / 2) / 25.4   # Convert to inches...
        time_ms_1 = int(1000 * abs(step_size / HomingClass.SPEED_FAST))
        motor_dist2 = -2 * step_size
        motor_steps2 = int(round(self.step_scale * motor_dist2))  # Round to nearest motor step

        self.nd_ref.machine.xy_move(motor_steps2, 0, time_ms_1)
        # Do second half of leftward move at slower speed, until limit switch.
        step_size = (HomingClass.SIDE_DIST) / 25.4   # Convert to inches
        time_ms = int(1000 * abs(step_size / self.speed_fine))
        motor_dist2 = -2 * step_size
        motor_steps2 = int(round(self.step_scale * motor_dist2))    # Round to nearest motor step

        if self.query_limit_switch() == 1:   # Switch pressed; cannot begin leftward move
            self.failed = True
            self.message_fun("Automatic homing failed. (Limit switch not ready; Precision stage)")
            return

        self.enable_limit_detection()

        self.nd_ref.machine.xy_move(motor_steps2, 0, time_ms)

        self.block()   # Wait for move to finish
        limit_occurred = self.nd_ref.plot_status.limit
        self.nd_ref.machine.command("CU,51,0")   # Disable limit switch detection

        if not limit_occurred:
            self.failed = True
            self.message_fun("Automatic homing failed. (Limit not found; precision stage)")
            return   # Precision homing completed. Moving Home.
        self.nd_ref.machine.xy_move(motor_steps1, -motor_steps1, 4 * time_ms_1)

        self.block()   # Wait for final move to finish

    def enable_limit_detection(self):
        ''' Enable limit switch detection features in firmware; moves stop on detection. '''
        self.nd_ref.machine.command("CU,52,2")   # Set LimitSwitchTarget (Bit 1 high; detect 1s)
        self.nd_ref.machine.command("CU,51,2")   # Set LimitSwitchMask: PB1 (Bit 1; 2's place)
        self.nd_ref.plot_status.limit = False   # Clear limit-detected flag

    def read_position(self):
        ''' Read XY position from machine and set global position to that value '''

        if self.nd_ref.options.preview:
            self.nd_ref.pen.phys.accum1 = 0   # Clear accumulator value
            self.nd_ref.pen.phys.accum2 = 0   # Clear accumulator value
        if (self.nd_ref.machine.port is None) or (self.nd_ref.machine.err is not None):
            return

        serial_utils.exhaust_queue(self.nd_ref)   # Wait until all motion stops

        pos = self.nd_ref.machine.query_steps()   # before querying motor position.
        offset = serial_utils.read_step_offsets(self.nd_ref)   # Query offset position
        if (pos is None) or offset is None:
            self.message_fun("Error reading step positions.")
            return

        offset_xy = steps_to_xy_pos(self.nd_ref, offset[0] / 1000, offset[1] / 1000)
        pos_xy = steps_to_xy_pos(self.nd_ref, pos[0], pos[1])

        self.nd_ref.pen.phys.xpos = pos_xy[0] - offset_xy[0]   # Set global position
        self.nd_ref.pen.phys.ypos = pos_xy[1] - offset_xy[1]   # Set global position
        self.nd_ref.pen.phys.accum1 = 0   # Clear accumulator value
        self.nd_ref.pen.phys.accum2 = 0   # Clear accumulator value
        self.nd_ref.machine.clear_accumulators()   # Clear accumulators on EBB

    def set_home(self):
        '''
        Reset step counter to zero at present position. Clear Origin Offset.
        Set machine to believe that it has been "homed."
        This becomes the "True" home position that walk_home returns to.
        '''
        serial_utils.exhaust_queue(self.nd_ref)   # Wait until all motion stops
        self.nd_ref.machine.clear_steps()   # Reset step position to (0,0)
        serial_utils.write_step_offsets(self.nd_ref, 0, 0)   # Reset offset positions to (0, 0)
        self.nd_ref.machine.var_write(1, 12)   # Update machine state: fully homed.
        self.read_position()   # Set xpos, ypos values

    def adjust_origin_offset(self, delta_x, delta_y):
        '''
        Read the current origin offset value and adjust it by the delta_x, delta_y inputs.
        delta_x and delta_y have units of inches.

        In detail:
        * Read out the existing origin offset (in units of steps * 1000), convert to XY inches.
        * Add delta_x, delta_y, to existing offset origin to get new XY origin offset values
        * Convert new origin offset values to units of steps * 1000
        * Write new origin offsets to EBB variables
        * Use read_position() to set the new xpos, ypos values accounting for the offset
        '''

        offset = serial_utils.read_step_offsets(self.nd_ref)   # Query offset position
        if offset is None:
            self.message_fun("Error reading step positions.")
            return

        offset_xy = steps_to_xy_pos(self.nd_ref, offset[0] / 1000, offset[1] / 1000)
        offset_x = offset_xy[0] + delta_x
        offset_y = offset_xy[1] + delta_y
        offset_ab = xy_to_step_pos(self.nd_ref, offset_x * 1000, offset_y * 1000)
        # Write new offset positions:
        serial_utils.write_step_offsets(self.nd_ref, offset_ab[0], offset_ab[1])
        self.read_position()   # Update xpos, ypos

    def xy_to_step_pos_with_offset(self, x_dest, y_dest):
        '''
        Find and return the absolute (A, B) step position corresponding to a given
        (X, Y) position in inches, accounting for any possible Origin Offset applied.
        Inputs x_dest, y_dest are in inches
        '''

        offset = serial_utils.read_step_offsets(self.nd_ref)   # Query offset position
        if offset is None:
            return None

        offset_xy = steps_to_xy_pos(self.nd_ref, offset[0] / 1000, offset[1] / 1000)
        x_dest += offset_xy[0]
        y_dest += offset_xy[1]
        dest_ab = xy_to_step_pos(self.nd_ref, x_dest, y_dest)

        return (dest_ab[0], dest_ab[1])

    def precision_move_to(self, x_dest, y_dest, rate=3000):
        '''
        Make an absolute move to the target destination with respect
        to the current Origin Offset. Read out new position.
        Inputs x_dest, y_dest are in inches.
        rate, if given, is in steps per second.
        This is a "dog leg" move that does not necessarily move in a straight line.
        Use for absolute positioning only, not for drawing.
        '''

        ab_pos_dest = self.xy_to_step_pos_with_offset(x_dest, y_dest)
        if ab_pos_dest is None:
            return

        if self.nd_ref.options.preview:
            move_dist = plot_utils.distance(x_dest - self.nd_ref.pen.phys.xpos,
                                            y_dest - self.nd_ref.pen.phys.ypos)
            self.nd_ref.plot_status.stats.add_dist(self.nd_ref, move_dist)
            ab_pos_read = self.xy_to_step_pos_with_offset(self.nd_ref.pen.phys.xpos,
                                                          self.nd_ref.pen.phys.ypos)
            a_steps = abs(ab_pos_read[0] - ab_pos_dest[0])
            b_steps = abs(ab_pos_read[1] - ab_pos_dest[1])

            steps = max(a_steps, b_steps)
            move_time = 1000 * (steps / rate)
            self.nd_ref.plot_status.stats.pt_estimate += move_time
            self.nd_ref.pen.phys.xpos = x_dest   # Update current position indicator.
            self.nd_ref.pen.phys.ypos = y_dest
            return

        ab_pos_read = serial_utils.read_step_position(self.nd_ref)
        if ab_pos_read is None:
            return

        if not ab_pos_dest == ab_pos_read:
            serial_utils.abs_move_wrapper(self.nd_ref, ab_pos_dest[0], ab_pos_dest[1], rate)
            move_dist_xy = steps_to_xy_pos(self.nd_ref,
                                           abs(ab_pos_dest[0] - ab_pos_read[0]),
                                           abs(ab_pos_dest[1] - ab_pos_read[1]))
            move_dist = plot_utils.distance(move_dist_xy[0], move_dist_xy[1])
            self.nd_ref.plot_status.stats.add_dist(self.nd_ref, move_dist)

        self.read_position()


if __name__ == '__main__':
    homer = HomingClass()
    homer.homing_selfcontained()
