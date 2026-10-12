# coding=utf-8
#
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
plan_utils.py

Utilities for trajectory planning routines

Part of the NextDraw driver software
http://bantamtools.com

"""
# pylint: disable=pointless-string-statement

import math
import logging

from nextdrawcore import cubic_eqn

from nextdrawcore.plot_utils_import import from_dependency_import  # plotink
plot_utils = from_dependency_import('plotink.plot_utils')
ebb_calc = from_dependency_import('plotink.ebb_calc')
message = from_dependency_import('ink_extensions_utils.message')

logger = logging.getLogger(__name__)

# Relate approximate Z position in inches to control signal. Generated from:
#   [(13/25.4) * math.sin(math.tau * (135 * step/100 - 67.5)/360) for step in range(101)]
#   Based on a range of 135 degrees from position 0 to 100, with 13 mm lever arm.
Z_MAP = [-0.473, -0.468, -0.463, -0.458, -0.452, -0.447, -0.441, -0.434, -0.428,
         -0.421, -0.414, -0.407, -0.399, -0.392, -0.384, -0.376, -0.368, -0.359, -0.350,
         -0.341, -0.332, -0.323, -0.314, -0.304, -0.294, -0.284, -0.274, -0.264, -0.254,
         -0.243, -0.232, -0.222, -0.211, -0.200, -0.188, -0.177, -0.166, -0.154, -0.143,
         -0.131, -0.119, -0.108, -0.096, -0.084, -0.072, -0.060, -0.048, -0.036, -0.024,
         -0.012, 0.000, 0.012, 0.024, 0.036, 0.048, 0.060, 0.072, 0.084, 0.096, 0.108,
         0.119, 0.131, 0.143, 0.154, 0.166, 0.177, 0.188, 0.200, 0.211, 0.222, 0.232,
         0.243, 0.254, 0.264, 0.274, 0.284, 0.294, 0.304, 0.314, 0.323, 0.332, 0.341,
         0.350, 0.359, 0.368, 0.376, 0.384, 0.392, 0.399, 0.407, 0.414, 0.421, 0.428,
         0.434, 0.441, 0.447, 0.452, 0.458, 0.463, 0.468, 0.473]


def calc_layer_speeds(nd_ref, layer_speed):
    """
    Calculate maximum speed on a given layer, based on speed settings, layer settings,
    and resolution settings.

    Returns pen-up and pen-down max speeds:
    speed_penup (in/s), speed_pendown(in/s), max_step_up (step/s), max_step_down (step/s).
    These represent the maximum speeds that are allowed in an arbitrary direction:
        Individual motors on the NextDraw may move at up to sqrt(2) * max speed, when
        pen is up or when constant-speed mode is disabled and turbo mode is enabled.

    """

    if layer_speed:
        speed_pendown = layer_speed
    else:
        speed_pendown = nd_ref.options.speed_pendown

    # Crop values to range of [1, 100]:
    speed_pendown = min(speed_pendown, 100)
    speed_penup = min(nd_ref.options.speed_penup, 100)
    speed_pendown = max(speed_pendown, 1)
    speed_penup = max(nd_ref.options.speed_penup, 1)

    # logger.debug(f'speed_pendown: {speed_pendown}') # Debug printing
    # logger.debug(f'speed_penup: {speed_penup}') # Debug printing

    # maximum step rates for motors, in steps per second
    max_step_down = nd_ref.params.max_step_rate * speed_pendown * 10
    max_step_up = nd_ref.params.max_step_rate * speed_penup * 10

    if nd_ref.params.resolution == 1:  # High-resolution ("Super") mode
        nd_ref.step_scale = 2.0 * nd_ref.params.native_res_factor

        speed_pendown = speed_pendown * nd_ref.params.speed_limit / 100.0
        speed_penup = speed_penup * nd_ref.params.speed_limit / 100.0

    else:  # i.e., nd_ref.params.resolution == 2; Low-resolution ("Normal") mode
        nd_ref.step_scale = nd_ref.params.native_res_factor
        # Low-res mode: Allow faster pen-up moves. Keep maximum pen-down speed the same.
        speed_penup = speed_penup * nd_ref.params.speed_limit / 100.0
        speed_pendown = speed_pendown * nd_ref.params.speed_limit / 100.0

    max_step_down = int(round(max_step_down))
    max_step_up = int(round(max_step_up))

    return speed_penup, speed_pendown, max_step_up, max_step_down


'''
def find_v_limit(vel_in, max_v_in, turbo):
    """
    Given an input velocity vel_in, return vector v_max, the maximum velocity allowed in 2D.
    Inputs:     vel_in, two-element list describing a velocity [v1, v2]
                max_v_in, maximum velocity allowed in arbitrary directions (float)
                turbo, if true, max_v_in applies *per axis* not to total velocity (Boolean)
    Returns:    v_max, two-element list describing maximum velocity [v1, v2]
    """
    v_1, v_2 = vel_in
    mag = math.sqrt(v_1 * v_1 + v_2 * v_2)
    if mag == 0:
        return [0, 0]
    if not turbo:
        return [max_v_in * v_1/mag, max_v_in * v_2/mag]
    if abs(v_1) >= abs(v_2):
        v_max = max_v_in * math.sqrt(1 + v_2 * v_2 / (v_1 * v_1))
        return [v_max * v_1/mag, v_max * v_2/mag]
    v_max = max_v_in * math.sqrt(1 + v_1 * v_1 / (v_2 * v_2))
    return [v_max * v_1/mag, v_max * v_2/mag]
'''


def calc_jerk(nd_ref):
    """
    Calculate and return pen-up, pen-down jerk, in in/s^3 units, based on active settings.

    TODO: RE-evaluate the approach here; possibly better to only scale jerk, not accel,
        As well as re-evaluating what particular values to use. May need to depend on
        NextDraw model for available jerk & accel.
    """

    # Crop option values to range of [1, 100] and scale
    # Scale as x^2, with x in range 0-1. 50% on accel scale -> 0.25 on jerk scale

    accel_scaled = min(nd_ref.options.accel, 100) / 100.0
    accel_scaled = accel_scaled * accel_scaled * accel_scaled
    jerk_pendown = nd_ref.params.jerk_pen_down * accel_scaled
    jerk_penup = nd_ref.params.jerk_pen_up * accel_scaled

    # logger.error(f'jerk_penup :{jerk_penup}. jerk_pendown: {jerk_pendown}') # Debug printing

    return jerk_penup, jerk_pendown


def scurve_plan(v_in, v_max, j_m, dist=None, min_time=None):
    """
    Plan an S-curve acceleration/deceleration in 1D, defined by the inputs provided:
        - Velocity input v_in,
        - Maximum velocity v_max,
        - Maximum jerk j_m,
        - Total distance dist
        - minimum time for the full s-curve move (optional)

    This function handles three possible cases:
    - If dist is None, return the distance needed to accelerate from v_in to speed v_max.
    - Otherwise, for an acceleration, calculate and return the maximum end speed v_f
        that can be achieved, starting at velocity v_in, with distance dist, limited by v_max.
    - Otherwise, for a deceleration, calculate and return the maximum initial speed v_i
        that can be used to end at velocity v_in, with distance dist, limited by v_max.

    Since the second two cases are mathematically identical, this function handles those
        two cases identically, and without extra logic to do so. Similarly, the distance
        needed to accelerate from v_in to v_max is equal to the distance needed to decelerate
        from v_max to v_in.

    Discussion: Basis for this motion plan

    The S-curve is a pair of collinear T3 moves accelerating from one speed
        to a different one. Position, velocity, AND acceleration are continuous
        throughout a chained series of S-curve accelerations and decelerations.
        The acceleration is zero at the beginning and end of the move.

    First part of move, from t = 0 to t = tm, a waypoint:
        x(t) = v_i t + (1/2) a1 t^2 + (1/6) j1 t^3
            assuming x_0 = 0, wolog, set the starting position at 0 position.
            v_i: initial velocity. a1, j1: acceleration, jerk during first part.

        Derivatives:
        v(t) = v_i + a1 t + (1/2) j1 t^2
        v'(t) = a1 + j1 t

        Label the waypoint velocity at the end of first part: v(t = tm) = v_mid

    Second part of move, from t2 = 0 to t2 = td, where t2 = t + tm, and T = tm + td is the
        total elapsed time in the two-move S-curve. Temporarily ignore the "x offset",
        knowing that the second part of the move begins at position x(t_m).
        x2(t2) = v_mid t2 + (1/2) a2 t2^2 + (1/6) j2 t2^3
            with a2: acceleration, j2: jerk during second part.

        Derivatives:
        v2(t2) = v_mid + a2 t + (1/2) j2 t^2
        v2'(t2) = a2 + j2 t

    Constraints:
        1. v(t = 0) = v_i              -- Initial velocity
        2. v2(t2 = td) = v_f           -- Final velocity
        3. v'(t = 0) = 0               -- accel is 0 at beginning of S-curve
        4. v2'(t2 = td) = 0            -- accel is 0 at end of S-curve
        5. v(t = tm) = v2(t2 = 0)      -- Velocity continuous where moves connect
        6. v'(t = tm) = v2'(t2 = 0)    -- Acceleration continuous where moves connect
        7. x(t=tm) + x2(t2=td) = dist  -- Final distance to be covered.

        Constraint 3:
            -> v'(t=0) = a1 + j1 * 0 = 0 ->                      [[ Key result (1): a1 = 0 ]]
        Constraint 4:
            -> v2'(t2 = td) = a2 + j2 td = 0 ->             [[ Key result (2): a2 = -j2 td ]]
        Constraint 5:
            -> v(t = tm) = v_i + 0 * tm + (1/2) j1 tm^2 = v2(t2 = 0) = v_mid
            ->                              [[ Key result (3): v_mid - v_i = (1/2) j1 tm^2 ]]
        Constraint 6:
            -> v'(t = tm) = j1 tm = v2'(t2 = 0) = a2 ->      [[ Key result (4): a2 = j1 tm ]]
        From (2) and (4), we get: j1 tm = -j2 td     -> [[ Key result (5): j2/j1 = - tm/td ]]

    Further, assume that tm == td; such that j2 = - j1, for a symmetric S-curve.
        We begin with:
            v2(t2 = tm) = v_mid + a2 tm + (1/2) j2 tm^2
        Using constraint 2 and result (3):
            v2(t2 = tm) = (v_i + (1/2) j1 tm^2) + a2 tm + (1/2) (-j1) tm^2 = v_f
            ->                                        [[ Key result (6): v_i + a2 tm = v_f ]]
        Constraint 7: x(t=tm) + x2(t2=td) = dist
            x(t=tm) = v_i tm + (1/6) j1 tm^3
            x2(t2=td) = v_mid td + (1/2) a2 td^2 + (1/6) (-j1) td^3
                      = (v_i + (1/2) j1 tm^2) tm + (1/2) a2 tm^2 - (1/6) j1 tm^3
                      = v_i td + (1/2 - 1/6)j1 tm^3 + (1/2) a2 tm^2
            -> x(tm)+ x2(td) = v_i tm + (1/6) j1 tm^3 +  v_i tm + (1/3)j1 tm^3 + (1/2) a2 tm^2
                             = 2 v_i tm + (1/2) a2 tm^2 + (1/2) j1 tm^3
                             = 2 v_i tm + (1/2) (j1 tm) tm^2 + (1/2) j1 tm^3
            ->                                [[ Key result (7): dist = 2 v_i tm + j1 tm^3 ]]
        With results (6) and (4), and noting tm == td:
            v_f - v_i = a2 tm = -j2 td tm = j1 tm^2
            ->                                     [[ Key result (8):  v_f = v_i + j1 tm^2 ]]
            ->                            [[ Key result (9):  tm = sqrt( (v_f - v_i) / j1) ]]
        Working with results (7) and (8):
            dist = 2 v_i tm + j1 tm^3 = 2 (v_f -j1 tm^2) tm + j1 tm^3
            ->                               [[ Key result (10):  dist = 2 v_f tm - j1 tm^3 ]]

    Finally note that in the case of acceleration, j1 > 0, j2 < 0,
        and for deceleration, j1 < 0, j2 > 0. In both cases, |j1| = |j2| = j_m.

    Plan (organized around case of acceleration):
        A. Calculate distance d_max required to get to v_max
        B. If dist is None, return d_max.
        C. If dist >= d_max, return v_max
        D. Solve cubic, result (7), to find tm
        E. Find v_f from tm (result (8)), return v_f.

    What about deceleration?
        For acceleration, we solve result (7),  dist = 2 v_i tm + j1 tm^3, for tm; v_i is known.
        For deceleration, we solve result (10), dist = 2 v_f tm - j1 tm^3, for tm; v_f is known.

        Substituting j1 = j_m for the acceleration case and j1 = -j_m for deceleration gives:
            dist = 2 v_i tm + j_m tm^3
            dist = 2 v_f tm + j_m tm^3
        Both cases are handled by: dist = 2 v_in tm + j_m tm^3, where v_in represents the input.

        Next, we use result (8), v_f = v_i + j1 tm^2:
            For acceleration: v_f = v_i + j1 tm^2 = v_in + j_m tm^2
            For deceleration: v_i = v_f - j1 tm^2 = v_in + j_m tm^2
        And thus the deceleration case is handled identically to acceleration, and we have
            found the correct velocity value to return.

    Final detail 1: The end speed of the first T3 motion command is not *exactly* equal
        to the beginning speed of the second T3 command. This is because there is one
        time interval between the two. If the two were exactly equal, that creates a
        velocity glitch. Instead, the second move starts with velocity increased by
        the accel value.

    Final detail 2: If the min_time argument is not None, then require that the
        minimum execution time is at least min_time. Typically, this means slowing down.

        Suppose that we want to accelerate from known initial speed v_i to a final speed v_f.
        Time to cover distance at slowest possible speed (without accelerating) is
        t = dist/v_i. If that time is too short; if dist/v_i < min_time, then we need to
        *decelerate* to make the movement segment longer in time.
        In this case, find the _maximum_ v_f that satisfies v_i, dist, j_max.

        Using key results (7) and (10):
            dist = 2 v_i tm + j1 tm^3  -> j1 tm^3 = dist - 2 v_i tm
            dist = 2 v_f tm - j1 tm^3  = 2 v_f tm - (dist - 2 v_i tm)
            -> 2 dist = 2 v_f tm + 2 v_i tm -> v_f = (dist - v_i tm)/tm
                                            And j1 = (dist - 2 v_i tm)/ tm^3

        Test with some sample cases show that the required jerk value here can be larger than
        j_max, indicating that v_i was too high! Fortunately, for forward look-aheads that this
        function is used for, we can assume that infinite jerk is possible *for deceleration*.
        Instead we simply note that the maximum v_f is given by: v_f = (dist - v_i tm)/tm

    """
    # logger.debug('@ s-curve planning')  # Debug printing

    inputs = [v_in, v_max, j_m]
    if None in inputs:  # These inputs must be provided, or else fail.
        return None

    v_in = abs(v_in)
    v_max = abs(v_max)
    j_m = abs(j_m)

    if j_m == 0:
        j_m = 1000  # Avoid div by zeroes... This function is sometimes called in const-velocity.

    # A. Calculate distance d_max required to get to v_max
    #     Get tm from key result (9):             tm = sqrt( (v_f - v_in) / j1)
    #     Then, get dist from key result (7):     dist = 2 v_in tm + j1 tm^3

    t_m = math.sqrt(abs(v_max - v_in) / j_m)  # Using j = j_m, v_f = v_max
    d_max = 2 * v_in * t_m + j_m * t_m * t_m * t_m

    if dist is None and math.isclose(t_m, 0):
        # B. If dist is None, return d_max; the distance to get to v_max.
        # logger.debug('Dist None; already at max v')  # Debug printing
        return 0

    if min_time is not None:
        if t_m < min_time/2:
            # logger.debug(f't_m: {t_m:.6f}; Extending distance to max')  # Debug printing

            t_m = min_time/2

            # v_f - v_i = jerk * t_m^2; Otherwise, set t_m, and find a lower value of jerk.
            jerk_new = abs(v_max - v_in) / (t_m * t_m)
            d_max = 2 * v_in * t_m + jerk_new * t_m * t_m * t_m

    if dist is None:    # B. If dist is None, return d_max; the distance to get to v_max.
        # logger.debug(f'Dist None; scurve_plan t_m: {t_m:.5f} s')  # Debug printing
        return d_max

    dist = abs(dist)

    if (dist >= d_max) or math.isclose(dist, d_max):
        return v_max      # C. If dist >= d_max, return v_max

    # D. Solve cubic to find tm:  j_m tm^3 + 0 * tm^2 + 2 v_in tm - dist == 0
    t_m = 1E100
    result = cubic_eqn.solve(j_m, 0, 2 * v_in, -dist)

    for item in result:  # Find shortest time that is not a complex or negative root
        if isinstance(item, complex):
            continue
        if 0 < item <= t_m:
            t_m = item

    if t_m > 1E90:  # No valid root found
        # logger.debug('ERROR: s-curve distance computation')  # Debug printing
        return None     # Return None, indicating failure.

    if min_time is not None:
        if t_m < min_time/2:
            # logger.debug(f't_m is below minimum: {t_m:.6f}')  # Debug printing

            t_m = min_time/2
            if v_in != 0:
                if (dist/v_in) < min_time:  # This is a *deceleration*!
                    # logger.debug('Actually a deceleration!')  # Debug printing
                    return max((dist - v_in * t_m)/t_m, 0)  # Fwd speed can never be < 0.

            # dist = 2 v_in tm + j_m tm^3. Set t_m & find a lower value of jerk.
            j_m = abs(dist - 2 * v_in * t_m) / (t_m * t_m * t_m)

            # logger.debug(f'  -> New j_m: {j_m:.0f}')  # Debug printing
            # logger.debug(f'  -> New v_f: {v_in + j_m * t_m * t_m:.6f}')  # Debug printing

    # logger.debug(f'scurve_plan t_m: {t_m:.5f} s')  # Debug printing

    # E. Find final velocity from tm:
    return min(v_max, v_in + j_m * t_m * t_m)  # Noting that v_f = v_i + j1 tm^2


def scurve_jerk(v_start, v_end, dist, max_jerk):
    """
    For an S-curve move, 1D, when v_i, v_f, and distance are known, but
        maximum jerk is too high to cover the necessary distance,
        find a lower-jerk solution for a single S-curve acceleration.

    Test with a starting duration of 0.006 s (6 ms)

    uses math from scurve_plan():

    tm = sqrt( (v_f - v_i) / j1)
        -> j1 tm^2 = v_f - v_i -> j1 = (v_f - v_i) / tm^2
        or v_f = v_i + j1 tm^2

    dist = 2 v_in tm + j1 tm^3.


    Want to find a value of j that makes the movement work with the given
        vi, vf, distance, max j.

    Min t_m defined by allowed length of TD, command, 1/2 of 6 ms.
    Max t_m defined by maximum jerk: tm = sqrt( (v_f - v_i) / j_max)

    A secondary lower limit on t_m is that the
    jerk flips sign when (dist - 2 * v_i * t_m) == 0 -- somewhat obviously.
    So, t_m cannot be allowed to go below that value.
    t_real_min = dist / (2 * v_i)
    """

    # print(f'plan_utils.scurve_jerk({v_start}, {v_end}, {dist}, {max_jerk})')

    v_i = min(v_start, v_end)
    v_f = max(v_start, v_end)

    if v_i == 0:
        tm_lower = max(0.003, dist / (2 * .001))  # Whichever is higher
    else:
        tm_lower = max(0.003, dist / (2 * v_i))  # Whichever is higher
    tm_upper = math.sqrt((v_f - v_i) / (max_jerk * 1.25))  # Lenient in max jerk!
    t_m = tm_lower + tm_upper/10  # Pick initial value near lower bound

    iteration = 0

    # print(f'Testing with v_i: {v_i}')
    # print(f'Testing with v_f: {v_f}')
    # print(f'Initial tm lower bound: {tm_lower}')
    # print(f'Initial tm upper bound: {tm_upper}')

    while iteration < 50:

        j_temp = abs(dist - 2 * v_i * t_m)/(t_m * t_m * t_m)
        v_f_temp = v_i + j_temp * t_m * t_m

        if math.isclose(v_f_temp, v_f, abs_tol=1E-6):
            return j_temp

        # print(f'Testing with tm: {t_m:.6f}:  ->  v_f_temp: {v_f_temp:.8f}')

        if v_f_temp > v_f:  # Final velocity is too high. Acceleration runs too long.
            tm_upper = t_m  # Upper bound
        else:   # Final velocity is too high. Acceleration runs too short.
            tm_lower = t_m  # Lower bound

        t_m = (tm_lower + tm_upper)/2.0

        iteration += 1

    return None


def scurve_jerk2(v_start, v_end, dist, max_jerk):
    """
    Same, but more lenient in max jerk, and more lenient in total move time.
    """

    # print(f'plan_utils.scurve_jerk2({v_start}, {v_end}, {dist}, {max_jerk})')

    v_i = min(v_start, v_end)
    v_f = max(v_start, v_end)

    if v_i == 0:
        tm_lower = max(0.002, dist / (2 * .001))  # Whichever is higher
    else:
        tm_lower = max(0.002, dist / (2 * v_i))  # Whichever is higher
    tm_upper = math.sqrt((v_f - v_i) / (max_jerk * 1.3))  # Lenient in max jerk!
    t_m = tm_lower + tm_upper/10  # Pick initial value near lower bound

    iteration = 0

    # print(f'Testing with v_i: {v_i}')
    # print(f'Testing with v_f: {v_f}')
    # print(f'Initial tm lower bound: {tm_lower}')
    # print(f'Initial tm upper bound: {tm_upper}')

    while iteration < 50:

        j_temp = abs(dist - 2 * v_i * t_m)/(t_m * t_m * t_m)
        v_f_temp = v_i + j_temp * t_m * t_m

        if math.isclose(v_f_temp, v_f, abs_tol=1E-6):
            return j_temp

        # print(f'Testing with tm: {t_m:.6f}:  ->  v_f_temp: {v_f_temp:.8f}')

        if v_f_temp > v_f:  # Final velocity is too high. Acceleration runs too long.
            tm_upper = t_m  # Upper bound
        else:   # Final velocity is too high. Acceleration runs too short.
            tm_lower = t_m  # Lower bound

        t_m = (tm_lower + tm_upper)/2.0

        iteration += 1

    return None


def scurve_time(v_i, v_f, jerk):
    """
    Find and return travel time for an S-curve move, 1D, when
    v_i, v_f, and jerk are known.

    Uses midpoint time t_m = math.sqrt( (v_max - v_in) / j_m),
        from scurve_plan().
    """
    if jerk == 0:
        return 0
    return 2 * math.sqrt(abs((v_f - v_i) / jerk))


def scurve_speeds(td_mov):
    """
    Find and return initial, mid, and final speeds, in an S-curve move.
    Values are imprecise, as we are not accounting for accumulator values
    that may build up between multiple moves.
    """

    if len(td_mov) == 10:
        time, v_1a, v_1b, a_1, j_1, v_2a, v_2b, a_2, j_2, _ = td_mov
    else:
        time, v_1a, v_1b, a_1, j_1, v_2a, v_2b, a_2, j_2 = td_mov

    rate_in = plot_utils.distance(v_1a, v_2a) * 25 / 2147483648

    vel_1 = ebb_calc.rate_t3(time, v_1a, 0, j_1)
    vel_2 = ebb_calc.rate_t3(time, v_2a, 0, j_2)

    rate_mid1 = plot_utils.distance(vel_1, vel_2) * 25 / 2147483648

    vel_1 = ebb_calc.rate_t3(time, v_1b, a_1, -j_1)
    vel_2 = ebb_calc.rate_t3(time, v_2b, a_2, -j_2)

    rate_mid2 = plot_utils.distance(v_1b, v_2b) * 25 / 2147483648

    rate_end = plot_utils.distance(vel_1, vel_2) * 25 / 2147483648

    return rate_in, rate_mid1, rate_mid2, rate_end


def striangle(v_i, v_f, v_max, jerk, dist):
    """
    Compute maximum velocity that can be achieved in a move made of two S-curves.

    This handles a special case, where:
    - A movement is required between two positions, with known distance, and known
        initial and final velocities.
    - The distance is longer than the minimum distance necessary to transit from
        the initial to final velocity with the given jerk value. So, we *can* go
        faster than v_i and v_f in the middle of the move.
    - The movement distance is too short to allow acceleration to v_max during
        the move.
    And, in that case, this function numerically computes the maximum velocity
        that *can* be achieved with the given jerk value, and for which the
        correct total distance will be traveled.

    Computing the velocity directly is not straightforward, so we approach it
        iteratively, trying to find the velocity that solves the distance
        needed. Resolution for distance assumes that units are all inch &
        second (not ISR) scale units.
    """

    # Lowest possible result would be highest of the start/finish speeds:
    lower_bound = max(v_i, v_f)
    upper_bound = v_max

    iterations = 0
    while True:
        test_v = (lower_bound + upper_bound)/2.0
        iterations += 1

        test_dist = scurve_plan(v_i, test_v, jerk, None) +\
            scurve_plan(v_f, test_v, jerk, None)

        if math.isclose(test_dist, dist, abs_tol=1E-5):
            return test_v
        if test_dist > dist:  # Velocity test_v is too high.
            upper_bound = test_v
        else:  # Velocity test_v is too low.
            lower_bound = test_v


def td_seg_data(td_params, xyz_pos, step_scale):
    """
    Update xyz_pos with movement due to the TD command specified with TD_params.

    Return
        - Total steps moved, motor 1 (steps)
        - Total steps moved, motor 2 (steps)
        - Overall distance (pythagorean; inch)
        - Final rate, motor 1 (ISR units)
        - Final rate, motor 2 (ISR units)

    The TD command is formatted as:
    TD,Intervals,Rate1A,Rate1B,Accel1,Jerk1,Rate2A,Rate2B,Accel2,Jerk2[,Clear]
    and, within the EBB firmware creates two T3 commands as:
    T3,Intervals,Rate1A,0,Jerk1,Rate2A,0,Jerk2[,Clear]
    T3,Intervals,Rate1B,Accel1,-Jerk1,Rate2B,Accel2,-Jerk2
    """

    move_time, v_1a, v_1b, a_1, j_1, v_2a, v_2b, a_2, j_2 = td_params

    # Pre-compute step divisor to avoid repeated calculation
    step_divisor = step_scale * 2.0

    td_steps_1A, xyz_pos.accum1 =\
        ebb_calc.move_dist_t3(move_time, v_1a, 0, j_1, xyz_pos.accum1)
    td_steps_2A, xyz_pos.accum2 =\
        ebb_calc.move_dist_t3(move_time, v_2a, 0, j_2, xyz_pos.accum2)

    # Direct int/float division eliminates float() conversion
    m_dist1 = td_steps_1A / step_divisor  # Relative position after
    m_dist2 = td_steps_2A / step_divisor  # this move, inch.
    x_delta = m_dist1 + m_dist2  # X Distance moved, inches
    y_delta = m_dist1 - m_dist2  # Y Distance moved, inches
    # Inline distance calculation: sqrt(x*x + y*y)
    subseg_inches = math.sqrt(x_delta * x_delta + y_delta * y_delta)  # Total move, inches

    xyz_pos.xpos += x_delta  # New absolute position after
    xyz_pos.ypos += y_delta  # this move, inch

    # rate_1 = ebb_calc.rate_t3(move_time, v_1a, 0, j_1)  # Not actually used
    # rate_2 = ebb_calc.rate_t3(move_time, v_2a, 0, j_2)  # Not actually used

    # ---- halftime party ----

    td_steps_1B, xyz_pos.accum1 =\
        ebb_calc.move_dist_t3(move_time, v_1b, a_1, -j_1, xyz_pos.accum1)
    td_steps_2B, xyz_pos.accum2 =\
        ebb_calc.move_dist_t3(move_time, v_2b, a_2, -j_2, xyz_pos.accum2)

    # Direct int/float division eliminates float() conversion
    m_dist1 = td_steps_1B / step_divisor  # Relative position after
    m_dist2 = td_steps_2B / step_divisor  # this move, inch.
    x_delta = m_dist1 + m_dist2  # X Distance moved, inches
    y_delta = m_dist1 - m_dist2  # Y Distance moved, inches
    # Inline distance calculation: sqrt(x*x + y*y)
    subseg_inches += math.sqrt(x_delta * x_delta + y_delta * y_delta)  # Total move, inches

    xyz_pos.xpos += x_delta  # New absolute position after
    xyz_pos.ypos += y_delta  # this move, inch

    rate_1 = ebb_calc.rate_t3(move_time, v_1b, a_1, -j_1)
    rate_2 = ebb_calc.rate_t3(move_time, v_2b, a_2, -j_2)

    return td_steps_1A + td_steps_1B, td_steps_2A + td_steps_2B, subseg_inches, rate_1, rate_2


def t3_seg_data(t3_params, xyz_pos, step_scale):
    """
    Update xyz_pos with movement due to the T3 command specified with t3_params.

    Return
        - Total steps moved, motor 1 (steps)
        - Total steps moved, motor 2 (steps)
        - Overall distance (pythagorean; inch)
        - Final rate, motor 1 (ISR units)
        - Final rate, motor 2 (ISR units)
    """

    f_current_x = xyz_pos.xpos  # X position as a float
    f_current_y = xyz_pos.ypos  # Y position as a float
    # f_pen_up = xyz_pos.z_up

    move_time, v_1, a_1, j_1, v_2, a_2, j_2 = t3_params

    t3_steps_1, xyz_pos.accum1 =\
        ebb_calc.move_dist_t3(move_time, v_1, a_1, j_1, xyz_pos.accum1)
    t3_steps_2, xyz_pos.accum2 =\
        ebb_calc.move_dist_t3(move_time, v_2, a_2, j_2, xyz_pos.accum2)

    m_dist1 = float(t3_steps_1) / (step_scale * 2.0)  # Relative position after
    m_dist2 = float(t3_steps_2) / (step_scale * 2.0)  # this move, inch.
    x_delta = m_dist1 + m_dist2  # X Distance moved, inches
    y_delta = m_dist1 - m_dist2  # Y Distance moved, inches
    subseg_inches = plot_utils.distance(x_delta, y_delta)  # Total move, inches

    xyz_pos.xpos = f_current_x + x_delta  # New absolute position after
    xyz_pos.ypos = f_current_y + y_delta  # this move, inch

    rate_1 = ebb_calc.rate_t3(move_time, v_1, a_1, j_1)
    rate_2 = ebb_calc.rate_t3(move_time, v_2, a_2, j_2)

    return t3_steps_1, t3_steps_2, subseg_inches, rate_1, rate_2
