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
dripfeed.py

Manage, or simulate, the process of feeding individual motion segments.

Part of the NextDraw driver for Inkscape
http://bantamtools.com

Requires Python 3.7 or newer.

"""

import logging
import time

from nextdrawcore.plot_utils_import import from_dependency_import  # plotink
plot_utils = from_dependency_import('plotink.plot_utils')  # https://github.com/evil-mad/plotink
# from nextdrawcore import plan_utils


def feed(nd_ref, move_list):
    """
    Feed individual motion actions to the NextDraw during a plot or preview.
    Take care of housekeeping while doing so, including:
        Checking for pause inputs
        Skipping physical moves while in preview mode
        Skipping physical moves while resuming plots
        Updating previews
        Updating node counts
        Updating CLI progress bar
        Keeping track of total distance traveled, pen-up and pen-down
        Sleeping during long moves
        Reporting errors to the user
    Inputs: NextDraw reference object, list of movement commands
    """

    if move_list is None:
        return
    if nd_ref.plot_status.stopped:
        return

    spew_dripfeed_debug_data = False  # Set True to get entirely too much debugging data

    drip_logger = logging.getLogger('.'.join([__name__, 'dripfeed']))
    if spew_dripfeed_debug_data:
        drip_logger.setLevel(logging.DEBUG)  # by default level is INFO

    # drip_logger.error('\ndripfeed.feed()')
    # drip_logger.error(' print full move_list:\n' + str(move_list)) # Can print full move list

    for move in move_list:
        already_stopped = nd_ref.plot_status.stopped
        nd_ref.pause_check()

        if nd_ref.plot_status.stopped and (not already_stopped):
            nd_ref.plot_status.copies_to_plot = 0

            nd_ref.machine.command("SP,3")  # Raise pen, ignoring queued lowering commands.

            # TODO HERE: Read last command, add braking move.

            return

        if nd_ref.pen.phys.xpos is None:
            return  # Physical location is not well-defined; stop here.

        if move is None:  # Handle special case of malformed move without a command.
            continue
        if len(move) == 0:  # Handle special case of malformed move without a command.
            continue

        if move[0] == 'lower':
            nd_ref.pen.pen_lower(nd_ref)
            continue

        if move[0] == 'raise':
            nd_ref.pen.pen_raise(nd_ref)
            continue

        nd_ref.plot_status.resume.drip.last_move = move  # Cache last motion command

        if move[0] == 'SM':
            feed_sm(nd_ref, move, drip_logger)
            continue

        if move[0] == 'T3':
            feed_t3(nd_ref, move, drip_logger)
            continue

        if move[0] == 'TD':
            feed_td(nd_ref, move, drip_logger)
            continue


def feed_sm(nd_ref, move, drip_logger):
    """
    Manage the process of sending a single "SM" move command to the NextDraw,
        and simulate doing so when in preview mode.
    Take care of housekeeping while doing so, including:
        Skipping physical moves while in preview mode
        Updating previews
        Updating progress bar (CLI)
        Keeping track of total distance traveled, pen-up and pen-down
        Sleeping during long moves
        Reporting errors to the user
    """

    # drip_logger.debug('\ndripfeed.feed_SM()\n')

    # 'SM' move is formatted as:
    # ['SM', (move_steps2, move_steps1, move_time), seg_data]
    # where seg_data begins with:
    #   * final x position, float
    #   * final y position, float
    #   * final pen_up state, boolean
    #   * travel distance (inch)

    move_steps2 = move[1][0]
    move_steps1 = move[1][1]
    move_time = move[1][2]
    f_new_x = move[2][0]
    f_new_y = move[2][1]
    move_dist = move[2][3]

    if nd_ref.options.preview:
        nd_ref.plot_status.stats.pt_estimate += move_time
        # log_sm_for_preview(nd_ref, move)

        nd_ref.preview.log_sm_move(nd_ref, move)

    else:
        nd_ref.machine.xy_move(move_steps2, move_steps1, move_time)

        if move_time > 50:  # Sleep before issuing next command
            if nd_ref.options.mode != "utility":
                time.sleep(float(move_time - 30) / 1000.0)
    # drip_logger.debug('XY move: (%s, %s), in %s ms', move_steps1, move_steps2, move_time)
    # drip_logger.debug('fNew(X,Y): (%.5f, %.5f)', f_new_x, f_new_y)

    nd_ref.plot_status.stats.add_dist(nd_ref, move_dist)  # Distance; inches
    nd_ref.plot_status.progress.update_auto(nd_ref.plot_status.stats)

    nd_ref.pen.phys.xpos = f_new_x  # Update current position
    nd_ref.pen.phys.ypos = f_new_y


def feed_t3(nd_ref, move, drip_logger):
    """
    Manage the process of sending a single "T3" move command to the NextDraw,
        and simulate doing so when in preview mode.
    Take care of housekeeping while doing so, including:
        Skipping physical moves while in preview mode
        Updating previews
        Updating progress bar (CLI)
        Keeping track of total distance traveled, pen-up and pen-down
        Sleeping during long moves
        Reporting errors to the user
    """

    # drip_logger.debug('\ndripfeed.feed_T3()\n')

    # 'T3' move is formatted as:
    # ['T3', (time, velocity1, accel1, jerk1, velocity2, accel2, jerk2), seg_data]
    # where seg_data begins with:
    #   * travel distance (inch)
    #   * xyz_pos object after move

    mov = move[1]
    move_dist = move[2][0]
    xyz_pos = move[2][1]

    f_new_x = xyz_pos.xpos
    f_new_y = xyz_pos.ypos
    accum1 = xyz_pos.accum1
    accum2 = xyz_pos.accum2

    move_time = mov[0] / 25.0  # Move time in milliseconds; 25 ticks per ms.

    if nd_ref.options.preview:
        nd_ref.plot_status.stats.pt_estimate += move_time
        nd_ref.preview.log_t3_move(nd_ref, move)

        # Uncomment both to list both on a preview:
        str_output = f'T3,{mov[0]},{mov[1]},{mov[2]},{mov[3]},{mov[4]},{mov[5]},{mov[6]}\r'
        # drip_logger.debug(str_output)  # print all moves

    else:
        str_output = f'T3,{mov[0]},{mov[1]},{mov[2]},{mov[3]},{mov[4]},{mov[5]},{mov[6]}\r'
        nd_ref.machine.command(str_output)
        # drip_logger.debug(str_output )  # print all moves

        if move_time > 50: # Sleep before issuing next command
            if nd_ref.options.mode != "utility":
                time.sleep(float(move_time - 30) / 1000.0)


    # drip_logger.debug('T3 move: in %s ms', move_time)
    # drip_logger.debug('fNew(X,Y): (%.5f, %.5f)', f_new_x, f_new_y)

    nd_ref.plot_status.stats.add_dist(nd_ref, move_dist) # Distance; inches
    nd_ref.plot_status.progress.update_auto(nd_ref.plot_status.stats)

    nd_ref.pen.phys.xpos = f_new_x  # Update current position
    nd_ref.pen.phys.ypos = f_new_y
    nd_ref.pen.phys.accum1 = accum1
    nd_ref.pen.phys.accum2 = accum2

    # drip_logger.debug(f'accum1: {accum1 } - @ dripfeed')
    # drip_logger.debug(f'accum2: {accum2 } - @ dripfeed')
    # drip_logger.debug(f'accum 1,2: {accum1 }, {accum2 } - @ dripfeed')
    # drip_logger.debug(f'position 1,2: {f_new_x :.6f}, {f_new_y:.6f} - @ dripfeed')



def feed_td(nd_ref, move, drip_logger):
    """
    Manage the process of sending a single "TD" move command to the NextDraw,
        and simulate doing so when in preview mode.

    The TD command is formatted as:
    TD,Intervals,Rate1A,Rate1B,Accel1,Jerk1,Rate2A,Rate2B,Accel2,Jerk2[,Clear]
    and, within the EBB firmware creates two T3 commands scheduled into the FIFO as so:
    T3,Intervals,Rate1A,0,Jerk1,Rate2A,0,Jerk2[,Clear]
    T3,Intervals,Rate1B,Accel1,-Jerk1,Rate2B,Accel2,-Jerk2

    Take care of housekeeping while doing so, including:
        Skipping physical moves while in preview mode
        Updating previews
        Updating progress bar (CLI)
        Keeping track of total distance traveled, pen-up and pen-down
        Sleeping during long moves
        Reporting errors to the user
    """

    # drip_logger.debug('\ndripfeed.feed_TD()')

    # 'TD' move is formatted as:
    # ['TD', (time, v1A, v1B, accel1, jerk1, v2A, v2B, accel2, jerk2), seg_data]
    # where seg_data begins with:
    #   * travel distance (inch)
    #   * xyz_pos object after move

    mov = move[1]


    # rate_in, rate_mid1, rate_mid2, rate_end = plan_utils.scurve_speeds(mov)
    # report = f'   TD v_in: {rate_in:.3f}, v_mid1: {rate_mid1:.3f}, '+\
                # 'v_mid1: {rate_mid2:.3f}, v_end: {rate_end:.3f}'
    # drip_logger.debug(report)


    move_dist = move[2][0]
    xyz_pos = move[2][1]

    f_new_x = xyz_pos.xpos
    f_new_y = xyz_pos.ypos
    accum1 = xyz_pos.accum1
    accum2 = xyz_pos.accum2

    move_time = 2 * mov[0] / 25.0 # Move time in milliseconds; 25 ticks per ms.

    if nd_ref.options.preview:
        nd_ref.plot_status.stats.pt_estimate += move_time
        nd_ref.preview.log_td_move(nd_ref, move)

        # Uncomment the three following lines to list them on a preview:
        str_output = f'TD,{mov[0]},{mov[1]},{mov[2]},{mov[3]},{mov[4]},{mov[5]},{mov[6]},'
        str_output += f'{mov[7]},{mov[8]}\r'
        # drip_logger.debug(str_output)  # print all moves

    else:
        str_output = f'TD,{mov[0]},{mov[1]},{mov[2]},{mov[3]},{mov[4]},{mov[5]},{mov[6]},'
        str_output += f'{mov[7]},{mov[8]}\r'
        nd_ref.machine.command(str_output)
        # drip_logger.debug(str_output )  # print all moves

        if move_time > 50: # Sleep before issuing next command
            if nd_ref.options.mode != "utility":
                time.sleep(float(move_time - 30) / 1000.0)

    # drip_logger.debug('TD move: in %s ms', move_time)
    # drip_logger.debug('fNew(X,Y): (%.5f, %.5f)', f_new_x, f_new_y)

    nd_ref.plot_status.stats.add_dist(nd_ref, move_dist, t_d=True) # Distance; inches
    nd_ref.plot_status.progress.update_auto(nd_ref.plot_status.stats)

    nd_ref.pen.phys.xpos = f_new_x  # Update current position
    nd_ref.pen.phys.ypos = f_new_y
    nd_ref.pen.phys.accum1 = accum1
    nd_ref.pen.phys.accum2 = accum2

    # drip_logger.debug(f'accum1: {accum1 } - @ dripfeed')
    # drip_logger.debug(f'accum2: {accum2 } - @ dripfeed')

    # drip_logger.debug(f'accum 1,2: {accum1 }, {accum2 } - @ dripfeed')
    # drip_logger.debug(f'position 1,2: {f_new_x :.6f}, {f_new_y:.6f} - @ dripfeed')

    # drip_logger.debug('dripfeed.feed_TD() --End\n')



def page_layer_delay(nd_ref, between_pages=True, delay_ms=None):
    """
    Execute page delay or layer delay, monitoring for pause signals.
    Set between_pages=True for page delays, false for layer delays.
    delay_ms is only used for layer delays.
    """

    if nd_ref.plot_status.stopped:
        return # No delay if stopped.

    if between_pages:
        if nd_ref.plot_status.copies_to_plot == 0:
            return # No delay after last copy, for page delays.
        nd_ref.plot_status.delay_between_copies = True # Set flag: Delaying between copies
        delay_ms = nd_ref.options.page_delay * 1000

    if not delay_ms: # If delay time is 0 or None, exit.
        return
    if delay_ms >= 1000: # Only launch progress bar for at least 1 s of delay time
        nd_ref.plot_status.progress.launch_sub(nd_ref,
            delay_ms, page=between_pages)

    # Number of rest intervals:
    sleep_interval = 100 # Time period to sleep, ms. Default: 100
    time_remaining = delay_ms

    while time_remaining > 0:
        if nd_ref.plot_status.stopped:
            break # Exit loop if stopped.
        if time_remaining < 150: # If less than 150 ms left to delay,
            sleep_interval = time_remaining     # do it all at once.

        if between_pages:
            nd_ref.plot_status.stats.page_delays += sleep_interval
        else:
            nd_ref.plot_status.stats.layer_delays += sleep_interval

        if nd_ref.options.preview:
            nd_ref.plot_status.stats.pt_estimate += sleep_interval
        else:
            time.sleep(sleep_interval / 1000) # Use short intervals for responsiveness
            nd_ref.plot_status.progress.update_sub_rel(sleep_interval) # update progress bar
            nd_ref.pause_check() # Detect button press while between plots
        time_remaining -= sleep_interval
    nd_ref.plot_status.progress.close_sub()
    nd_ref.plot_status.delay_between_copies = False # clear flag
