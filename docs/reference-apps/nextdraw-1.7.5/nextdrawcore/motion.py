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
motion.py

Trajectory planning routines

Part of the NextDraw driver for Inkscape

Requires Python 3.8 or newer.
"""
# pylint: disable=pointless-string-statement

import copy
import math
import logging
from array import array

from nextdrawcore import plan_utils
from nextdrawcore.plot_utils_import import from_dependency_import  # plotink
plot_utils = from_dependency_import('plotink.plot_utils')
ebb_calc = from_dependency_import('plotink.ebb_calc')

# Constants: rounded-up maximum distances covered by 1 step in low-res/hi-res modes.
# We skip movements shorter than these distances, likely to be < 1 step.
MAX_STEP_DIST_LR = 0.000696  # Max in Low Res mode ~1/(1016 sqrt(2)) inch
MAX_STEP_DIST_HR = 0.000348  # Max in Hi Res mode ~1/(2032 sqrt(2)) inch


def trajectory(nd_ref, vertex_list, xyz_pos=None):
    """
    Plan the trajectory for a full path, beginning with lowering the pen and ending with
        raising the pen.

    Inputs: Ordered (x,y) pair vertex list, corresponding to a single polyline.
            nd_ref: reference to an NextDraw() object with its settings
            xyz_pos: A pen_handling.PenPosition object, giving XYZ position to be used
                as initial XYZ position for the purpose of computing the trajectory.
                The default, None, will cause the current XYZ position to be used,

    Output: move_list: A list of specific motion commands to execute.
            Commands may include: Pen lift, pen lower, horizontal movement, etc.
            [['lift', (params tuple), (seg_data)],
            ['SM', (params tuple), (seg_data)],
            ['T3', (params tuple), (seg_data)],...

            seg_data: Segment data list for a motion segment.
                * final x position, float
                * final y position, float
                * final pen_up, boolean
                * Distance plotted
                * execution time to plot this element (possible future addition)
    """

    move_list = []
    move_list.append(['lower', None])     # Initial pen lowering; default parameters.

    if xyz_pos is None:
        xyz_pos = copy.copy(nd_ref.pen.phys)
    xyz_pos.z_up = False  # Set initial pen_up state for trajectory calculation to False
    middle_moves = plan_trajectory(nd_ref, vertex_list, xyz_pos)

    if middle_moves is None:
        print('\n****  NO middle_moves\n')
        return None  # Skip pen lower and raise if there is no trajectory to plot

    move_list.extend(middle_moves)

    # if move_list[-1][0] == "T3":
    #     f_current_x = move_list[-1][2][0]
    #     f_current_y = move_list[-1][2][0]

    move_list.append(['raise', None])     # final pen raising; default parameters.

    # print(f"move_list: {move_list}")

    return move_list


def plan_trajectory(nd_ref, vertex_list, xyz_pos=None):
    """
    Plan the trajectory for a full path, accounting for acceleration.

    Inputs: nd_ref: reference to an NextDraw() object with its settings
            Ordered (x,y) pair vertex list, corresponding to a single polyline.
            xyz_pos: A pen_handling.PenPosition object, giving XYZ position to be used
                as initial XYZ position for the purpose of computing the trajectory.
                The default, None, will cause the current XYZ position to be used,

    Output: move_list, data_list
            move_list: A list of specific motion commands to execute, formatted as:
            ['T3', (params tuple), (seg_data)]

            seg_data: Segment data list for a motion segment.
                * final x position, float
                * final y position, float
                * final pen_up, boolean
                * Distance plotted
                * execution time to plot this element (possible future addition)

            data_list: Trajectory data after the end of the motions
                * Updated xyz_pos object
                * Distance plotted in this trajectory
                *
                * execution time to plot this element  (possible future addition)
    """

    traj_logger = logging.getLogger('.'.join([__name__, 'trajectory']))

    # spew_trajectory_debug_data = True # Set True to get entirely too much debugging data
    # if spew_trajectory_debug_data:
    #     traj_logger.setLevel(logging.debug) # by default level is INFO
    # traj_logger.setLevel(logging.debug) # by default level is INFO

    traj_logger.debug('\nplan_trajectory()\n')

    traj_length = len(vertex_list)
    if traj_length < 2:  # Invalid path segment
        return None, None

    if nd_ref.pen.phys.xpos is None:
        return None, None

    if xyz_pos is None:
        xyz_pos = copy.copy(nd_ref.pen.phys)

    f_pen_up = xyz_pos.z_up

    # Handle simple segments (lines) that do not require any complex planning:
    if traj_length < 3:  # "SHORTPATH ESCAPE"
        # Get X & Y Destination coordinates from last element, vertex_list[1]:
        segment_input_data = (vertex_list[1][0], vertex_list[1][1], 0, 0, False)

        move_list = []
        move_temp, data_list = compute_segment(nd_ref, segment_input_data, xyz_pos)

        if data_list is not None:  # Update current position
            xyz_pos = data_list[0]

        if move_temp is not None:
            move_list.extend(move_temp)

        return move_list

    traj_logger.debug('Input path to plan_trajectory:')
    x_last = vertex_list[0][0]
    y_last = vertex_list[0][1]
    for x_y in vertex_list:

        tmp_dist2 = plot_utils.distance(x_y[0] - x_last, x_y[1] - y_last)
        traj_logger.debug(f'x: {x_y[0]:.6f}, y: {x_y[1]:.6f} -> seg length :: {tmp_dist2:.6f}')

        x_last = x_y[0]
        y_last = x_y[1]
    traj_logger.debug('\ntraj_length: %s', traj_length)

    speed_limit = nd_ref.speed_pendown  # Maximum travel rate (in/s), in XY plane.
    if f_pen_up:
        speed_limit = nd_ref.speed_penup  # For pen-up manual moves

    # traj_logger.debug(f'\n*** *** \nspeed_limit: {speed_limit:.3f}')
    # traj_logger.debug(f'  nd_ref.speed_pendown: {nd_ref.speed_pendown:.3f}')
    # traj_logger.debug(f'  nd_ref.speed_penup: {nd_ref.speed_penup:.3f}')

    traj_dists = array('f')  # float, Segment length (distance) when arriving at the junction
    traj_vels = array('f')  # float, Velocity (_speed_, really) when arriving at the junction

    traj_vectors = []  # Array that will hold normalized unit vectors along each segment
    trimmed_path = []  # Array that will hold usable segments of vertex_list

    traj_dists.append(0.0)  # First value, at time t = 0
    traj_vels.append(0.0)  # First value, at time t = 0

    if nd_ref.params.resolution == 1:  # High-resolution mode
        min_dist = MAX_STEP_DIST_HR  # Skip segments likely to be < one step
    else:
        min_dist = MAX_STEP_DIST_LR  # Skip segments likely to be < one step

    last_index = 0
    for i in range(1, traj_length):
        # Construct arrays of position and distances, skipping near-zero length segments.

        # TODO: Ensure that long sequences of very short distances will generate motion.

        tmp_dist_x = vertex_list[i][0] - vertex_list[last_index][0]  # Distance per segment
        tmp_dist_y = vertex_list[i][1] - vertex_list[last_index][1]

        tmp_dist = plot_utils.distance(tmp_dist_x, tmp_dist_y)

        if tmp_dist >= min_dist:
            traj_dists.append(tmp_dist)
            # Normalized unit vectors for computing cosine factor
            traj_vectors.append([tmp_dist_x / tmp_dist, tmp_dist_y / tmp_dist])
            tmp_x = vertex_list[i][0]
            tmp_y = vertex_list[i][1]
            trimmed_path.append([tmp_x, tmp_y])  # Selected, usable portions of vertex_list.
            # traj_logger.debug('\nSegment: vertex_list[%s] -> [%s]', last_index, i)
            # traj_logger.debug('Dest: x: %.3f,  y: %.3f. Dist.: %.3f', tmp_x, tmp_y, tmp_dist)
            last_index = i
        else:
            # traj_logger.debug('\nSegment: vertex_list[%s] -> [%s]: near zero; skipping.',
            #     last_index, i)
            # traj_logger.debug(f'  x: {vertex_list[i][0]:1.3f}, ' +
            #     f'y: {vertex_list[i][1]:1.3f}, distance: {tmp_dist:1.3f}')
            pass

    traj_length = len(traj_dists)

    if traj_length < 2:
        # traj_logger.debug('\nSkipped a path element without well-defined segments.')
        return None, None  # Handle zero-segment plot

    if traj_length < 3:  # plot the element if it is just a line
        # traj_logger.debug('\nDrawing straight line, not a curve.')
        segment_input_data = (trimmed_path[0][0], trimmed_path[0][1], 0, 0, False)
        return compute_segment(nd_ref, segment_input_data, xyz_pos)

    jerk_up, jerk_down = plan_utils.calc_jerk(nd_ref)

    # Acceleration/deceleration rates:
    if f_pen_up:
        jerk_rate = jerk_up  # Value in inch/s^3
    else:
        jerk_rate = jerk_down

    """
    Perform forward and reverse look-ahead checks for the path,
    towards planning the motion profile.
    """

    # Possible to-do item: Use deque to keep track of average move length.
    #   assume, for decelerations, that each move is 0.007s long (assume worst case)

    for i in range(1, traj_length - 1):

        seg_length = traj_dists[i]  # Length of the segment leading up to this vertex
        v_prev_exit = traj_vels[i - 1]  # Velocity when leaving previous vertex

        traj_logger.debug(f'\nDistance, this segment: {seg_length:.6f}')

        """
        Velocity at vertex: Part I

        Check to see what our plausible maximum speeds are, from
        jerk only, without concern about cornering, nor deceleration.

        Secondary concern: Movement segments need to be, on average, at least 6 ms long.
        """

        # traj_logger.debug(f'Velocity at vertex: Part I')  # Debug printing
        # traj_logger.debug(f'    v_prev_exit: {v_prev_exit:.6f}')
        # traj_logger.debug(f'    speed_limit: {speed_limit:.6f}')
        # traj_logger.debug(f'    seg_length: {seg_length:.6f}')
        # traj_logger.debug(f'    jerk_rate: {jerk_rate:.3f}')

        vcurrent_max = plan_utils.scurve_plan(v_prev_exit, speed_limit, jerk_rate,
                                              seg_length, min_time=.007)

        if vcurrent_max is None:
            # traj_logger.debug(f'ERROR SKIPPING SEGMENT ')
            continue

        traj_logger.debug(f'    max v at end of segment: {vcurrent_max:.6f}')

        """
        Velocity at vertex: Part II

        Assuming that we have the same velocity when we enter and
        leave a corner, our acceleration limit provides a velocity
        that depends upon the angle between input and output directions.

        The dot product of the unit vectors is equal to the cosine of the angle between
        incoming and outgoing unit vectors.
        """

        # Calculate velocity limit as projection of current velocity along new vector,
        # or zero, if angle change is > 90 degrees.

        vec = traj_vectors[i - 1]
        vel_len = plot_utils.distance(traj_vectors[i - 1][0], traj_vectors[i - 1][1])
        v_j_1 = [vec[0] / vel_len, vec[1] / vel_len]

        vec = traj_vectors[i]
        vel_len = plot_utils.distance(traj_vectors[i][0], traj_vectors[i][1])
        v_j_2 = [vec[0] / vel_len, vec[1] / vel_len]

        cosine_factor = plot_utils.dotProductXY(v_j_1, v_j_2)  # If neither motor reverses

        if cosine_factor < 0:  # Angle greater than 90°
            cosine_factor = 0

        # Constrain speed at fast corners by cos^4 of angle between them,
        #   and also 80% max speed:

        if vcurrent_max > speed_limit * 0.5:
            vcurrent_max = min(vcurrent_max, vcurrent_max * (cosine_factor**4))
        elif vcurrent_max > speed_limit * 0.25:
            vcurrent_max = min(vcurrent_max, vcurrent_max * (cosine_factor))
        vcurrent_max = min(vcurrent_max, speed_limit * 0.8)

        # Possible future work: Use resolution-limited speed limits for one or both
        #   of the above, instead of the

        traj_vels.append(vcurrent_max)  # "Forward-going" speed limit at this vertex.

    traj_vels.append(0.0)  # Add zero velocity, for final vertex.
    # (Possible future work: Set to nonzero value for ramping Z.)

    traj_logger.debug('\n')
    # for dist in traj_vels:
    #     traj_logger.debug('traj_vels II: %.3f', dist)

    """
    Velocity at vertices: Part III

    We have, thus far, ensured that we could reach the desired velocities, going forward, but
    have also assumed an effectively infinite deceleration rate.

    We now go through the completed array in reverse, limiting velocities to ensure that we
    can properly decelerate in the given distances.
    """

    # traj_logger.debug(f'\nVertex III: Reverse checks')

    for j in range(1, traj_length):
        i = traj_length - j  # Range: From (traj_length - 1) down to 1.

        v_final = traj_vels[i]
        v_initial = traj_vels[i - 1]

        seg_length = traj_dists[i]
#         traj_logger.debug(f'    Dist: {seg_length:.3f}')
#         traj_logger.debug(f'    v_i:  {v_initial:.3f}')
#         traj_logger.debug(f'    v_f:  {v_final:.3f}')
#         traj_logger.debug(f'    v_i:  {v_initial}')
#         traj_logger.debug(f'    v_f:  {v_final}')

        if seg_length <= 0 or v_initial < v_final or\
                math.isclose(v_initial, v_final, abs_tol=1E-9):
            # traj_logger.debug(f'      v_f > v_i; No decel check needed needed')
            pass
        else:

            v_init_max = plan_utils.scurve_plan(v_final, speed_limit, jerk_rate,
                                                seg_length, min_time=0.007)

            traj_vels[i - 1] = min(v_initial, v_init_max)

    #     for i in range(1, traj_length):
    #         v_final = traj_vels[i]
    #         v_initial = traj_vels[i - 1]
    #
    #
    #         traj_logger.debug(f' Dist: {traj_dists[i]:.6f}')
    #         traj_logger.debug(f'   v_i: {v_initial:.6f}')
    #         traj_logger.debug(f'   v_f: {v_final:.6f}')

    # traj_logger.debug(f'\n\nFinal velocities before computing segments:')
    # for i in range(0, traj_length):
    #     if i == 0:
    #         traj_logger.debug(f'  Dist: {traj_dists[i]:.6f}, v_i: -,         v_f: -')
    #     else:
    #         traj_logger.debug(
    #          f'  Dist: {traj_dists[i]:.6f}, v_i: {traj_vels[i-1]:.6f},  v_f: {traj_vels[i]:.6f}')

    # traj_logger.debug(f'\nDists: {traj_dists}')
    # traj_logger.debug(f'Vels:  {traj_vels}')

    move_list = []
    for i in range(0, traj_length - 1):

        segment_input_data = (trimmed_path[i][0], trimmed_path[i][1],
                              traj_vels[i], traj_vels[i + 1], False)

        segment = compute_segment(nd_ref, segment_input_data, xyz_pos)

        if segment[0] is not None:
            move_temp, data_list = segment
            xyz_pos = data_list[0]  # Update current position
            move_list.extend(move_temp)

    return move_list


def compute_segment(nd_ref, data, xyz_pos=None):
    """
    Plan a straight line segment with given initial and final velocity.

    Calculates T3/TD motion commands, and returns a list of them.

    Inputs:
            nd_ref: reference to an NextDraw() object with its settings
            data tuple, in form of (Xfinal, Yfinal, Vinitial, Vfinal, ignore_limits)
            xyz_pos: A pen_handling.PenPosition object, giving XYZ position to be used
                as initial XYZ position for the purpose of computing the trajectory.
                The default, None, will cause the current XYZ position to be used,

    Output: move_list, data_list
            move_list: A list of specific motion commands to execute.
            Commands may include: Pen lift, pen lower, horizontal movement, etc.
            [['lift', (params tuple), (seg_data)],
            ['T3', (params tuple), (seg_data)]]
            ['TD', (params tuple), (seg_data)]]

            seg_data: Segment data list for a motion segment.
                * final x position, float
                * final y position, float
                * final pen_up, boolean
                * Distance plotted
                * execution time to plot this element (possible future addition)

            data_list: Trajectory data list for the vertex list
                * final x position, float
                * final y position, float
                * final pen_up, boolean
                * Distance plotted
                * execution time to plot this element  (possible future addition)

    Method: Very short moves handled as a single T3 move. Longer moves handled
    as a set of short T3 moves with double/quadruple cubic velocity profiles.

    Input positions and velocities are in distances of inches and velocities
    of inches per second.

    Within this routine, we convert from inches into motor steps.

    Note: Native motor axes are Motor 1, Motor 2:
        motor_dist1 = ( xDist + yDist ) # Distance for motor to move, Axis 1
        motor_dist2 = ( xDist - yDist ) # Distance for motor to move, Axis 2

    We will only discuss motor steps, and resolution, within the context of native axes.
    """

    x_dest, y_dest, vi_inch_per_s, vf_inch_per_s, ignore_limits = data
    # The velocities are actually *speed* along direction of this segment.

    if xyz_pos is None:
        xyz_pos = copy.copy(nd_ref.pen.phys)

    f_current_x = xyz_pos.xpos  # X position as a float
    if f_current_x is None:
        return None, None  # Cannot function without a starting position.

    f_current_y = xyz_pos.ypos  # Y position as a float
    f_pen_up = xyz_pos.z_up

    seg_logger = logging.getLogger('.'.join([__name__, 'segment']))
    # seg_logger.debug(f'\ncompute_segment()')

    constant_vel_mode = False
    if nd_ref.params.const_speed and not f_pen_up:
        constant_vel_mode = True

    if not ignore_limits:   # check page size limits:
        tolerance = nd_ref.params.bounds_tolerance  # Truncate up to 1 step w/o error.
        x_dest, x_bounded = plot_utils.checkLimitsTol(x_dest, nd_ref.bounds[0][0],
                                                      nd_ref.bounds[1][0], tolerance)
        y_dest, y_bounded = plot_utils.checkLimitsTol(y_dest, nd_ref.bounds[0][1],
                                                      nd_ref.bounds[1][1], tolerance)
        if x_bounded or y_bounded:
            nd_ref.warnings.add_new('bounds', nd_ref.params.model_name)

    delta_x_inches = x_dest - f_current_x
    delta_y_inches = y_dest - f_current_y

    # Look at distance to move along 45-degree axes, for native motor steps:
    # Recall that step_scale gives a scaling factor for converting from inches to steps,
    #   *not* native resolution
    # nd_ref.step_scale is Either 1016 or 2032, for 8X or 16X microstepping, respectively.

    motor_dist1 = delta_x_inches + delta_y_inches  # Inches that belt must turn at Motor 1
    motor_dist2 = delta_x_inches - delta_y_inches  # Inches that belt must turn at Motor 2
    motor_steps_1 = int(round(nd_ref.step_scale * motor_dist1))  # Round to nearest motor step
    motor_steps_2 = int(round(nd_ref.step_scale * motor_dist2))  # Round to nearest motor step

    # Keep track of rounded step distance to move, not just the _requested_ distance to move.
    # Convert back to find X & Y distances to move:
    motor_dist1_rounded = float(motor_steps_1) / (2.0 * nd_ref.step_scale)
    motor_dist2_rounded = float(motor_steps_2) / (2.0 * nd_ref.step_scale)
    delta_x_inches_rounded = motor_dist1_rounded + motor_dist2_rounded
    delta_y_inches_rounded = motor_dist1_rounded - motor_dist2_rounded

    if abs(motor_steps_1) < 1 and abs(motor_steps_2) < 1:  # If movement is < 1 step, skip it.
        return None, None

    dist_inch = plot_utils.distance(delta_x_inches_rounded, delta_y_inches_rounded)
    # seg_logger.debug(f'segment_length_inch: {dist_inch:.6f}')

    jerk_up, jerk_down = plan_utils.calc_jerk(nd_ref)  # Units of in/s^3

    if f_pen_up:
        speed_limit = nd_ref.speed_penup  # Maximum travel speeds
        jerk_rate = jerk_up
    else:
        speed_limit = nd_ref.speed_pendown  # Maximum travel speeds
        jerk_rate = jerk_down

    if constant_vel_mode:
        vi_inch_per_s = speed_limit
        vf_inch_per_s = speed_limit
    else:
        vi_inch_per_s = min(vi_inch_per_s, speed_limit)
        vf_inch_per_s = min(vf_inch_per_s, speed_limit)

    # seg_logger.debug(f'Current pos:  ({f_current_x:.6f}, {f_current_y:.6f})')
    # seg_logger.debug(f'Current Dest: ({x_dest:.6f}, {y_dest:.6f})')
    # seg_logger.debug(f'vi_inch_per_s: {vi_inch_per_s:.3f}')
    # seg_logger.debug(f'vf_inch_per_s: {vf_inch_per_s:.3f}')
    # seg_logger.debug(f'speed_limit: {speed_limit:.3f}')
    # seg_logger.debug(f'speed_limit: {speed_limit:.3f}')
    # seg_logger.debug(f'jerk_rate: {jerk_rate:.3f}')
    # seg_logger.debug(f'nd_ref.step_scale: {nd_ref.step_scale:.3f}')

    # Declare arrays to efficiently store data for the move. We keep data for each
    #   sub-segment, processing them into motion commands at the end. This lets us work
    #   through the "flowchart" of different possible moves, and then construct them
    #   after, only computing each type of sub-move command in *one* place.
    #       For subseg_array, use these codes
    #           * 1: S-Curve, accelerating
    #           * 2: S-Curve, decelerating
    #           * 3: Constant velocity segment
    #           * 4: Short move mode segment
    #       The last subsegment (last element of subseg_array) will always end with the
    #           defined v_f and final position, so arrays dist_array and vel_array can
    #           be one shorter in length than subseg_array.

    subseg_array = array('B')  # unsigned char. Code, as above, for type of subsegment
    dist_array = array('f')  # float. Distance, inch, along segment after each subsegment
    vel_array = array('f')  # float. Velocity inch/s, along segment after each subsegment
    jerk_array = array('f')  # float. jerk value for each subsegment

    # Possible future TODO case to add: Very long accelerations could be broken into
    #   smaller sections to avoid inaccuracy. Could also have a constant-acceleration
    #   section added to the middle of the S-curve.

    case = 0
    if math.isclose(vi_inch_per_s, 0):
        const_speed_time = 100  # Tagging it as "not a short-time duration segment"
    else:
        const_speed_time = dist_inch/vi_inch_per_s  # Time = distance/speed

    if constant_vel_mode or (math.isclose(vi_inch_per_s, speed_limit) and
                             math.isclose(vf_inch_per_s, speed_limit)):
        case = 3  # Constant speed segment
        # Possible future work: Split into a number of constant-speed segments here.
        # seg_logger.debug(f'\nConst-segment at max speed')

    elif (math.isclose(vi_inch_per_s, vf_inch_per_s, abs_tol=1E-2) and
            (const_speed_time < 0.013)):
        case = 3
        # Constant speed segment with very short transit time;
        #   Use a constant speed here so that we reduce the number of motion cmds.

        # seg_logger.debug(f'\nConst-speed segment; same start/end speed')
        # seg_logger.debug(f't at vi: {const_speed_time:.6f}')

    elif (math.isclose(vi_inch_per_s, vf_inch_per_s, abs_tol=1E-2) and
            (const_speed_time < 0.030) and (vi_inch_per_s > speed_limit / 2)):
        case = 3    # Smooth motion here rather than a triangle or trapezoid.
        # Smooths motion at higher speeds.

    else:
        # Distances needed for S-curve accel to, decel from max speed:
        accel_dist_inch = plan_utils.scurve_plan(vi_inch_per_s, speed_limit, jerk_rate, None)
        decel_dist_inch = plan_utils.scurve_plan(vf_inch_per_s, speed_limit, jerk_rate, None)

        # Distance to accelerate from v_i to v_max, and then decelerate to v_f:
        dist_svm = accel_dist_inch + decel_dist_inch

        # Minimum distance to accelerate from v_i to v_f (or vice versa):
        if vi_inch_per_s <= vf_inch_per_s:
            dist_sse = plan_utils.scurve_plan(vi_inch_per_s, vf_inch_per_s, jerk_rate, None)
        else:
            dist_sse = plan_utils.scurve_plan(vf_inch_per_s, vi_inch_per_s, jerk_rate, None)

        t_sse = plan_utils.scurve_time(vi_inch_per_s, vf_inch_per_s, jerk_rate)

        # seg_logger.error(f'\ndist_inch: {dist_inch:.6f}')
        # seg_logger.error(f'dist_svm: {dist_svm:.6f}')
        # seg_logger.error(f'dist_sse: {dist_sse:.6f}')
        # seg_logger.error(f'vi_inch_per_s: {vi_inch_per_s:.6f}')
        # seg_logger.error(f'vf_inch_per_s: {vf_inch_per_s:.6f}')
        # if vi_inch_per_s > 0:
        #     seg_logger.error(f't at vi: {dist_inch/vi_inch_per_s:.6f}')

        # TODO -- adding to this WIP:
        #   Consider minimum movement time here. If the movement is already very short in
        #   time -- under 12 ms, try to finesse it to work as a single motion segment,
        #   without breaking it into subsegments such as trapezoid or triangle.

        if math.isclose(vi_inch_per_s, 0):  # Prevent zero-rate from acting as though
            t_sse = max(t_sse, 1.0)        # it gives zero transit time.

        # seg_logger.debug(f't_sse: {t_sse:.3f}')

        if dist_inch >= dist_svm:  # Distance is long enough that move can get to max speed
            if math.isclose(vi_inch_per_s, speed_limit):  # Starts at max speed
                if math.isclose(dist_inch, dist_svm):
                    case = 2  # Single deceleration from maximum speed
                else:
                    case = 4  # constant speed + decel section
            elif math.isclose(vf_inch_per_s, speed_limit):  # Ends at max speed
                if math.isclose(dist_inch, dist_svm):
                    case = 1  # Single acceleration to maximum speed
                else:
                    case = 5  # accel to max + constant speed section
            else:
                case = 6  # Full "trapezoid" profile with accel, const, decel
        else:  # dist < dist_svm
            # Special case to handle moves that start AND stop near zero velocity
            if math.isclose(vi_inch_per_s, vf_inch_per_s, abs_tol=1E-3) and\
                    math.isclose(vi_inch_per_s, 0, abs_tol=1E-3):
                # Special case: Moves that start and stop at zero speed
                #   should _always_ be triangle moves.
                case = 7  # "Triangle" move that does not reach maximum speed.

            elif dist_inch > dist_sse:
                case = 7  # "Triangle" move that does not reach maximum speed.

            elif math.isclose(dist_inch, dist_sse, abs_tol=1E-3):
                # or\
                # ((dist_inch > dist_sse) and t_sse < 0.012):
                # Only enough room to accel/decel to final
                # Some tolerance on this to handle discretization errors.
                # Possible future work: recompute required/acceptable jerk in cases
                #   where the rounding produces a change in the actual move distance
                #
                # ALSO use these for cases that could be "triangle" moves, execept
                #   that doing so would create two moves under 6 ms duration.

                # if math.isclose(vi_inch_per_s, vf_inch_per_s, abs_tol=1E-3):
                #     case = 3 # Constant-velocity segment
                # el
                if vi_inch_per_s < vf_inch_per_s:
                    case = 1  # Single acceleration to final speed
                else:
                    case = 2  # Single deceleration to final speed

            # else:
            #     case = 0 # Handle cases that require reduced jerk.
                # Handle special case of motion that needs to happen at reduced
                #   jerk, to handle cases where move duration has been extended to
                #   prevent overly-short moves.

                # seg_logger.debug('Error; failed to plan motion segment.')
                # seg_logger.debug(f'   Dist: {dist_inch}, SSE: {dist_sse}')

        # seg_logger.error(f'Case: {case}')

    jerk_array.append(jerk_rate)

    # seg_logger.debug(f'   MOVE CASE: {case}')
    if case == 1:  # Single acceleration to final speed
        subseg_array.append(1)  # S-Curve, accelerating
    elif case == 2:  # Single deceleration to final speed
        subseg_array.append(2)  # S-Curve, decelerating
    elif case == 3:
        # seg_logger.debug(' Constant-velocity segment!')
        subseg_array.append(3)  # Constant velocity segment
    elif case == 4:
        # constant speed at max_v + decel section

        subseg_array.append(3)  # Constant velocity segment
        dist_array.append(dist_inch - decel_dist_inch)
        vel_array.append(speed_limit)

        subseg_array.append(2)  # S-Curve, decelerating
        jerk_array.append(jerk_rate)  # Add to match subseg_array length

    elif case == 5:
        # accel section + constant speed at max_v
        subseg_array.append(1)  # S-Curve, accelerating
        dist_array.append(accel_dist_inch)
        vel_array.append(speed_limit)

        subseg_array.append(3)  # Constant velocity segment
        jerk_array.append(jerk_rate)  # Add to match subseg_array length

    elif case == 6:
        seg_logger.debug('  Trapezoid segment!')

        subseg_array.append(1)  # S-Curve, accelerating
        dist_array.append(accel_dist_inch)
        vel_array.append(speed_limit)

        # seg_logger.debug(f' S-Curve, accel to {speed_limit} in/s, in {accel_dist_inch} in.')

        subseg_array.append(3)  # Constant velocity segment
        dist_array.append(dist_inch - decel_dist_inch)
        vel_array.append(speed_limit)

        subseg_array.append(2)  # S-Curve, decelerating
        # dist_array.append(segment_length_inch)
        # vel_array.append(vf_inch_per_s)

        jerk_array.append(jerk_rate)  # Add to match subseg_array length
        jerk_array.append(jerk_rate)  # Add to match subseg_array length

    elif case == 7:
        seg_logger.debug('  Possible triangle segment!')

        v_mid = plan_utils.striangle(vi_inch_per_s, vf_inch_per_s,
                                     speed_limit, jerk_rate, dist_inch)

        time_1 = plan_utils.scurve_time(vi_inch_per_s, v_mid, jerk_rate)
        time_2 = plan_utils.scurve_time(v_mid, vf_inch_per_s, jerk_rate)
        seg_logger.debug(f'Total triangle time: {time_1 + time_1:.5f}')

        time_3 = 0
        j_temp = plan_utils.scurve_jerk(vi_inch_per_s, vf_inch_per_s, dist_inch, jerk_rate)
        if j_temp is not None:

            time_3 = plan_utils.scurve_time(vi_inch_per_s, vf_inch_per_s, j_temp)
            seg_logger.debug(f'Time as single-move: {time_3:.5f}')

        # ERROR: This does not really work because it's assuming that we *do*
        # have a worked-out single S-curve move that covers the correct distance.
        #   we *do not*.

        if time_3 != 0:  # If single-move time is zero, always use triangle.
            # But, skip triangle if it's slower than a simple accel, or if
            #   there isn't enough movement time for two separate motion cmds.
            if ((time_1 + time_2) > time_3) or ((time_1 + time_2) < 0.012):
                # if vi_inch_per_s < vf_inch_per_s:
                #     case = 1 # Single acceleration to final speed
                # else:
                #     case = 2 # Single deceleration to final speed
                case = 0
                # case = 7

        # if case == 1: # Single acceleration to final speed
        #     subseg_array.append(1) # S-Curve, accelerating
        # elif case == 2: # Single deceleration to final speed
        #     subseg_array.append(2) # S-Curve, decelerating
        # else:   # Actually do the triangle
        if case == 7:
            seg_logger.debug('  Confirmed; using triangle.')
            accel_dist_inch = plan_utils.scurve_plan(vi_inch_per_s, v_mid, jerk_rate, None)
            subseg_array.append(1)  # S-Curve, accelerating
            dist_array.append(accel_dist_inch)
            vel_array.append(v_mid)
            subseg_array.append(2)  # S-Curve, decelerating
            jerk_array.append(jerk_rate)  # Add to match subseg_array length

        # seg_logger.debug('  Confirmed; using triangle.')
        # accel_dist_inch = plan_utils.scurve_plan(vi_inch_per_s, v_mid, jerk_rate, None)
        # subseg_array.append(1) # S-Curve, accelerating
        # dist_array.append(accel_dist_inch)
        # vel_array.append(v_mid)
        # subseg_array.append(2) # S-Curve, decelerating
        # jerk_array.append(jerk_rate) # Add to match subseg_array length

    if case == 0:
        # Handle special case of motion that needs to happen at reduced
        #   jerk, to handle cases where move duration has been extended to
        #   prevent overly-short moves.

        # if dist_inch < dist_sse:

        j_temp = plan_utils.scurve_jerk(vi_inch_per_s, vf_inch_per_s, dist_inch, jerk_rate)
        if j_temp is None:
            j_temp = plan_utils.scurve_jerk2(vi_inch_per_s, vf_inch_per_s, dist_inch, jerk_rate)
        if j_temp is not None:
            seg_logger.debug(f'  New j: {j_temp:.3f}')

            jerk_array[-1] = j_temp
            if vi_inch_per_s < vf_inch_per_s:
                subseg_array.append(1)  # S-Curve, accelerating
            else:
                subseg_array.append(2)  # S-Curve, decelerating
        else:
            # seg_logger.error('Error; failed to plan motion segment.') # TODO set to debug
            # seg_logger.error(f'   Dist: {dist_inch}, SSE: {dist_sse}')
            return None, None

    # Initial conditions & parameters for this motion segment
    params = [vi_inch_per_s, xyz_pos, motor_steps_1, motor_steps_2,
              nd_ref.step_scale, vf_inch_per_s, dist_inch]

    return compute_subsegment_cmds(params, subseg_array, dist_array,
                                   vel_array, jerk_array)


def compute_subsegment_cmds(params, subseg_array, dist_array, vel_array, jerk_array):
    """
    Compute individual motion commands for the moves within a single linear motion segment.
    The motion segment can be a pure S-curve acceleration or deceleration, an S-curve based
    "trapezoid" in speed, a constant-motion segment, or some combination of these.

    Inputs:
        - Initial conditions, including initial position & accumulator values
        - Parameters for the move
        - Arrays with segment codes, distances, velocities

    Returns:
        - Move list
        - data list
    """

    # subseg_logger = logging.getLogger('.'.join([__name__, 'subseg']))
    # subseg_logger.debug('\ncompute_subsegment_cmds()')

    vi_inch_per_s, xyz_pos, motor_steps_1, motor_steps_2, step_scale, \
        vf_inch_per_s, segment_length_inch = params

    # Pre-calculate commonly used constants
    velocity_scale = step_scale * (2147483648 / 25000)  # Pre-calculate
    jerk_scale = step_scale * 2147483648 / (25000 ** 3)  # Pre-calculate
    isr_to_steps = 1.0 / 2147483648  # Pre-calculate

    motor_step_dist = plot_utils.distance(motor_steps_1, motor_steps_2)
    # Use direction of full segment to give direction of final velocity.
    # These values are both scaled by sqrt(2), as a shortcut for the motor scaling.
    v_norm_1 = math.sqrt(2) * motor_steps_1 / motor_step_dist  # For finding direction
    v_norm_2 = math.sqrt(2) * motor_steps_2 / motor_step_dist  # of velocity

    prev_motor_1 = 0
    prev_motor_2 = 0

    # Use input velocity, projected along direction of the new segment.
    prev_vel_isr_1 = round((vi_inch_per_s * velocity_scale) * v_norm_1)
    prev_vel_isr_2 = round((vi_inch_per_s * velocity_scale) * v_norm_2)

    move_list = []
    subsegment_count = len(subseg_array)

#   Extra debug printouts:
#   for index in range(0, subsegment_count):
#         if index == subsegment_count - 1:
#             motor_dest_1 = motor_steps_1
#             motor_dest_2 = motor_steps_2
#
#             m_dist1 = float(motor_dest_1) / (step_scale * 2.0) # Relative position after
#             m_dist2 = float(motor_dest_2) / (step_scale * 2.0) #   this move, inch.
#             x_delta = m_dist1 + m_dist2 # X Distance moved, inches
#             y_delta = m_dist1 - m_dist2 # Y Distance moved, inches
#             subseg_inches = plot_utils.distance(x_delta, y_delta) # Total move, inches
#
#             subseg_logger.debug(f'Requested distances inches: {subseg_inches :.5f}')
#         else:
#             motor_dest_1 = round(motor_steps_1 * dist_array[index] / segment_length_inch)
#             motor_dest_2 = round(motor_steps_2 * dist_array[index] / segment_length_inch)
#
#             m_dist1 = float(motor_dest_1) / (step_scale * 2.0) # Relative position after
#             m_dist2 = float(motor_dest_2) / (step_scale * 2.0) #   this move, inch.
#             x_delta = m_dist1 + m_dist2 # X Distance moved, inches
#             y_delta = m_dist1 - m_dist2 # Y Distance moved, inches
#             subseg_inches = plot_utils.distance(x_delta, y_delta) # Total move, inches
#
#             subseg_logger.debug(f'dist_array[index] inches: {subseg_inches :.5f}')

    for index in range(0, subsegment_count):

        # subseg_logger.debug(f'\n Next Subseg, type {subseg_array[index]}\n')

        if index == subsegment_count - 1:
            # For last sub-segment, always end with required final position and speed
            motor_dest_1 = motor_steps_1
            motor_dest_2 = motor_steps_2
            subsegment_vf = vf_inch_per_s
        else:
            subsegment_vf = vel_array[index]
            motor_dest_1 = round(motor_steps_1 * dist_array[index] / segment_length_inch)
            motor_dest_2 = round(motor_steps_2 * dist_array[index] / segment_length_inch)

        # subseg_logger.debug(f'motor_dest_1 for this sub-segment: {motor_dest_1}')
        # subseg_logger.debug(f'motor_dest_2 for this sub-segment: {motor_dest_2}')
        # subseg_logger.debug(f'prev_motor_1: {prev_motor_1}')
        # subseg_logger.debug(f'prev_motor_2: {prev_motor_2}')

        steps_subseg_1 = motor_dest_1 - prev_motor_1
        steps_subseg_2 = motor_dest_2 - prev_motor_2

        # subseg_logger.debug(f'motor_steps_1 for this sub-segment: {steps_subseg_1}')
        # subseg_logger.debug(f'motor_steps_2 for this sub-segment: {steps_subseg_2}')

        # Final velocity along direction of travel in ISR units:
        vel_isr_1 = round((subsegment_vf * velocity_scale) * v_norm_1)
        vel_isr_2 = round((subsegment_vf * velocity_scale) * v_norm_2)

        jerk_rate = jerk_array[index]
        jerk_1 = jerk_rate * jerk_scale * v_norm_1
        jerk_2 = jerk_rate * jerk_scale * v_norm_2

        # subseg_logger.debug(f'jerk_1: {jerk_1:.5f}')
        # subseg_logger.debug(f'jerk_2: {jerk_2:.5f}')

        # subseg_logger.debug(f'subsegment_vf: {subsegment_vf:.5f}')
        # subseg_logger.debug(f'v_norm_1: {v_norm_1:.5f}')
        # subseg_logger.debug(f'v_norm_2: {v_norm_2:.5f}')
        # subseg_logger.debug(f'vel_isr_1: {vel_isr_1:.5f}')
        # subseg_logger.debug(f'vel_isr_2: {vel_isr_2:.5f}')
        # dist1 = float(steps_subseg_1) / (2.0 * step_scale)
        # dist2 = float(steps_subseg_2) / (2.0 * step_scale)
        # dx_inch = dist1 + dist2
        # dy_inch = dist1 - dist2
        # subseg_logger.debug(f'subseg_length_inch: {plot_utils.distance(dx_inch, dy_inch):.5f}')

        t_1 = 0
        t_2 = 0

        if subseg_array[index] == 1:  # S-Curve, accelerating
            '''
            S-curve acceleration uses two T3 moves:
                * First with J > 0, a = 0,
                * Second with J < 0, a > 0
            Math for S-curves is discussed in plan_utils.scurve_plan().

            Initial velocity: prev_vel_isr_1, prev_vel_isr_2
            Final velocity: vel_isr_1, vel_isr_2
            Distances to travel: steps_subseg_1, steps_subseg_2

            Jerk will be set at maximum jerk; accel is fixed by jerk.
            Jerk sign (first part) is in same direction as initial velocity,
                since we are accelerating in one direction or the other.
            Time is the main unknown to solve for, using
                Time_midpoint = sqrt( (v_f - v_i) / jerk)

            Note that v_f here (vel_isr_x) is the velocity at the END of
            the S-curve; the first T3 move only gets partway to that value.

            If the time on the two axes
            disagrees, pick the larger of the two.
            '''

            # subseg_logger.error(f'S-Curve, accelerating')
            # subseg_logger.debug(f'Start prev_vel_isr_1: {prev_vel_isr_1}')
            # subseg_logger.debug(f'Start prev_vel_isr_2: {prev_vel_isr_2}')

            j_1 = round(jerk_1)
            j_2 = round(jerk_2)

            if j_1 != 0:
                t_1 = round(math.sqrt(abs((vel_isr_1 - prev_vel_isr_1) / j_1)))
                # subseg_logger.debug(f'Time 1: {t_1:.3f} ticks; {t_1/25000:.5f} s ')

            if j_2 != 0:
                t_2 = round(math.sqrt(abs((vel_isr_2 - prev_vel_isr_2) / j_2)))
                # subseg_logger.debug(f'Time 2: {t_2:.3f} ticks; {t_2/25000:.5f} s ')

            test_dist_1 = ebb_calc.move_dist_t3(t_1, prev_vel_isr_1, 0, j_1)[0]
            test_dist_2 = ebb_calc.move_dist_t3(t_2, prev_vel_isr_2, 0, j_2)[0]
            if abs(test_dist_1) > abs(test_dist_2):
                move_time = t_1
            else:
                move_time = t_2
            # A naive approach based on time, move_time = max(t_1, t_2), chokes in cases
            # where (for example) one axis has zero steps.

            if move_time == 0:
                # subseg_logger.error(f'No Move!')
                continue  # No acceleration time needed.

            # subseg_logger.debug(f'jerk_1: {jerk_1:.3f}, rounded to j_1: {j_1}')
            # subseg_logger.debug(f'jerk_2: {jerk_2:.3f}, rounded to j_2: {j_2}')

            td_params = [move_time, prev_vel_isr_1, None, None, j_1,
                         prev_vel_isr_2, None, None, j_2]

            a_1 = round(jerk_1 * move_time)  # accel 1, 2 for second T3 command
            a_2 = round(jerk_2 * move_time)

            vel_1 = ebb_calc.rate_t3(move_time, prev_vel_isr_1, 0, j_1)
            vel_2 = ebb_calc.rate_t3(move_time, prev_vel_isr_2, 0, j_2)
            # subseg_logger.debug(f'vel_1: {vel_1:.3f}')

            # 2nd part: Initial rate on second half of move begins at end speed of
            #   first
            td_params[2] = vel_1 + a_1
            td_params[3] = a_1
            td_params[6] = vel_2 + a_2
            td_params[7] = a_2

            td_steps_1, td_steps_2, subsubseg_inches_td, prev_vel_isr_1, prev_vel_isr_2 =\
                plan_utils.td_seg_data(td_params, xyz_pos, step_scale)

            seg_data = [subsubseg_inches_td, copy.copy(xyz_pos)]

            move_list.append(['TD', td_params, seg_data])

            # subseg_logger.debug(f'TD params 1: {td_params}')

            seg_data = [subsubseg_inches_td, copy.copy(xyz_pos)]

            # subseg_logger.error(f'Move log: TD, {td_params}')
            # subseg_logger.error(f'TD seg_data: {seg_data}')

            prev_motor_1 = prev_motor_1 + td_steps_1
            prev_motor_2 = prev_motor_2 + td_steps_2

            # subseg_logger.debug(f'New prev_motor_1: {prev_motor_1}')
            # subseg_logger.debug(f'New prev_motor_2: {prev_motor_2}')
            # subseg_logger.debug(f'New prev_vel_isr_1: {prev_vel_isr_1} =\
            #     {prev_vel_isr_1 / (2**31):.3f} * 2^31')
            # subseg_logger.debug(f'new prev_vel_isr_2: {prev_vel_isr_2} =\
            #     {prev_vel_isr_2 / (2**31):.3f} * 2^31')

        elif subseg_array[index] == 2:  # S-Curve, decelerating
            '''
            S-curve acceleration uses two T3 moves:
                * First with J < 0, a = 0,
                * Second with J > 0, a < 0
            Math for S-curves is discussed in plan_utils.scurve_plan().

            Initial velocity: prev_vel_isr_1, prev_vel_isr_2
            Final velocity: vel_isr_1, vel_isr_2
            Distances to travel: steps_subseg_1, steps_subseg_2

            Jerk will be set at maximum jerk; accel is fixed by jerk.
            Jerk sign (first part) is in same direction as initial velocity,
                since we are accelerating in one direction or the other.
            Time is the main unknown to solve for, using
                Time_midpoint = sqrt( (v_f - v_i) / jerk)

            Note that v_f here (vel_isr_x) is the velocity at the END of
            the S-curve; the first T3 move only gets partway to that value.

            If the time on the two axes
            disagrees, pick the larger of the two.
            '''

            # subseg_logger.error(f'S-Curve, decelerating')

            j_1 = -round(jerk_1)
            j_2 = -round(jerk_2)

            if j_1 != 0:
                t_1 = round(math.sqrt(abs((vel_isr_1 - prev_vel_isr_1) / j_1)))
                # subseg_logger.debug(f'Time 1: {t_1:.3f} ticks; {t_1/25000:.5f} s ')

            if j_2 != 0:
                t_2 = round(math.sqrt(abs((vel_isr_2 - prev_vel_isr_2) / j_2)))
                # subseg_logger.debug(f'Time 2: {t_2:.3f} ticks; {t_2/25000:.5f} s ')

            test_dist_1 = ebb_calc.move_dist_t3(t_1, prev_vel_isr_1, 0, j_1)[0]
            test_dist_2 = ebb_calc.move_dist_t3(t_2, prev_vel_isr_2, 0, j_2)[0]
            if abs(test_dist_1) > abs(test_dist_2):
                move_time = t_1
            else:
                move_time = t_2

            if move_time == 0:
                continue  # No acceleration time needed.

            # subseg_logger.debug(f'jerk_1: {jerk_1:.3f}, rounded to j_1: {j_1}')
            # subseg_logger.debug(f'jerk_2: {jerk_2:.3f}, rounded to j_2: {j_2}')

            td_params = [move_time, prev_vel_isr_1, None, None, j_1,
                         prev_vel_isr_2, None, None, j_2]

            a_1 = round(-jerk_1 * move_time)  # accel 1, 2 for second T3 command
            a_2 = round(-jerk_2 * move_time)

            vel_1 = ebb_calc.rate_t3(move_time, prev_vel_isr_1, 0, j_1)
            vel_2 = ebb_calc.rate_t3(move_time, prev_vel_isr_2, 0, j_2)

            # 2nd part: Initial rate on second half of move begins at end speed of
            #   first
            td_params[2] = vel_1 + a_1
            td_params[3] = a_1
            td_params[6] = vel_2 + a_2
            td_params[7] = a_2

            # Note that jerk is reversed, in each direction, for the second T3 command

            td_steps_1, td_steps_2, subsubseg_inches_td, prev_vel_isr_1, prev_vel_isr_2 =\
                plan_utils.td_seg_data(td_params, xyz_pos, step_scale)

            seg_data = [subsubseg_inches_td, copy.copy(xyz_pos)]

            move_list.append(['TD', td_params, seg_data])

            # subseg_logger.debug(f'Move log: TD, {td_params}')

            prev_motor_1 = prev_motor_1 + td_steps_1
            prev_motor_2 = prev_motor_2 + td_steps_2

            # subseg_logger.debug(f'New prev_motor_1: {prev_motor_1}')
            # subseg_logger.debug(f'New prev_motor_2: {prev_motor_2}')
            # subseg_logger.debug(f'prev_motor_1: {prev_motor_1}')
            # subseg_logger.debug(f'prev_motor_2: {prev_motor_2}')
            # subseg_logger.debug(f'New prev_vel_isr_1: {prev_vel_isr_1} = {prev_vel_isr_1 / (2**31):.3f} * 2^31')
            # subseg_logger.debug(f'new prev_vel_isr_2: {prev_vel_isr_2} = {prev_vel_isr_2 / (2**31):.3f} * 2^31')
            # subseg_logger.debug(f'f_current_x: {xyz_pos.xpos}')
            # subseg_logger.debug(f'f_current_y: {xyz_pos.ypos}')
            # subseg_logger.debug(f'\nEnd Second part of move...\n\n')

        elif subseg_array[index] == 3:  # subseg_array value 3: Constant velocity segment
            # We already have velocity, but need the transit time.
            # transit time = distance / velocity

            # TODO: Separate into sections of no more than ~25 ms.

            # subseg_logger.error(f'Constant Vel Segment!')

            # subseg_logger.debug(f'steps_subseg_1: {steps_subseg_1:.5f}')
            # subseg_logger.debug(f'steps_subseg_2: {steps_subseg_2:.5f}')
            # subseg_logger.debug(f'prev_vel_isr_1: {prev_vel_isr_1:.5f}')
            # subseg_logger.debug(f'prev_vel_isr_2: {prev_vel_isr_2:.5f}')

            if vel_isr_1 != 0:
                t_1 = math.ceil(abs(steps_subseg_1 / (vel_isr_1 * isr_to_steps)))

            if vel_isr_2 != 0:
                t_2 = math.ceil(abs(steps_subseg_2 / (vel_isr_2 * isr_to_steps)))

            test_dist_1 = ebb_calc.move_dist_t3(t_1, vel_isr_1, 0, 0)[0]
            test_dist_2 = ebb_calc.move_dist_t3(t_2, vel_isr_2, 0, 0)[0]
            if abs(test_dist_1) > abs(test_dist_2):
                move_time = t_1
            else:
                move_time = t_2

            # subseg_logger.debug(f't_1: {t_1:.5f}')
            # subseg_logger.debug(f't_2: {t_2:.5f}')
            # subseg_logger.debug(f'move_time: {move_time:.5f}')

            if move_time == 0:
                continue

            # T3(time, V1, A1, J1, V2, A2, J2)
            t3_params = [move_time, vel_isr_1, 0, 0, vel_isr_2, 0, 0]

            t3_steps_1, t3_steps_2, subseg_inches, prev_vel_isr_1, prev_vel_isr_2 =\
                plan_utils.t3_seg_data(t3_params, xyz_pos, step_scale)

            seg_data = [subseg_inches, copy.copy(xyz_pos)]

            move_list.append(['T3', t3_params, seg_data])
            # subseg_logger.debug(f'Move log: T3, {t3_params}')
            # subseg_logger.debug(f'T3 seg_data: {seg_data}')
            # subseg_logger.debug(f't3_steps_1: {t3_steps_1}')
            # subseg_logger.debug(f't3_steps_2: {t3_steps_2}')

            prev_motor_1 = prev_motor_1 + t3_steps_1
            prev_motor_2 = prev_motor_2 + t3_steps_2

            # subseg_logger.debug(f'New prev_motor_1: {prev_motor_1}')
            # subseg_logger.debug(f'New prev_motor_2: {prev_motor_2}')
            # subseg_logger.debug(f'New prev_vel_isr_1: {prev_vel_isr_1} =\
            #     {prev_vel_isr_1 / (2**31):.3f} * 2^31')
            # subseg_logger.debug(f'new prev_vel_isr_2: {prev_vel_isr_2} =\
            #     {prev_vel_isr_2 / (2**31):.3f} * 2^31')

    # data_list keeps track of current state for computing next segment.
    # data_list *was* [f_current_x, f_current_y, f_pen_up, accum_1, accum_2]
    data_list = [xyz_pos]

    return move_list, data_list
