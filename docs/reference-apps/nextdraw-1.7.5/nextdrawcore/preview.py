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
preview.py

Classes for managing NextDraw plot preview data

Part of the NextDraw driver software
http://bantamtools.com
"""
# pylint: disable=pointless-string-statement


# import time
import functools
import math
import logging

from lxml import etree

from nextdrawcore.plot_utils_import import from_dependency_import
simpletransform = from_dependency_import('ink_extensions.simpletransform')
simplestyle = from_dependency_import('ink_extensions.simplestyle')
inkex = from_dependency_import('ink_extensions.inkex')
plot_utils = from_dependency_import('plotink.plot_utils')
ebb_calc = from_dependency_import('plotink.ebb_calc')

logger = logging.getLogger(__name__)


@functools.cache
def format_precision_width(width_value, units=''):
    """
    Cached precision width formatting with optimized calculation.

    This function handles both stroke widths and other width values that need
    variable precision formatting. Uses range-based precision for common values
    to avoid repeated "expensive" mathematical operations.

    The motivation for this function is that Stroke-width is a css style attribute
    that cannot use scientific notation, yet we need a wide range of precision.

    Args:
        width_value (float): The width value to format
        units (str): Optional units to append (e.g., 'in', 'px', '')

    Returns:
        str: Formatted width string with appropriate precision and optional units
    """
    if width_value >= 1.0:
        formatted = f"{width_value:.3f}"
    elif width_value >= 0.1:
        formatted = f"{width_value:.4f}"
    elif width_value >= 0.01:
        formatted = f"{width_value:.5f}"
    elif width_value >= 0.001:
        formatted = f"{width_value:.6f}"
    elif width_value >= 0.0001:
        formatted = f"{width_value:.7f}"
    else:
        # Fallback for very small values (cached after first calculation)
        log_ten = math.log10(width_value)
        precision = int(math.ceil(-log_ten) + 3)
        formatted = f"{width_value:.{precision}f}"

    return formatted + units


class VelocityChart:
    """ Preview: Class for velocity data plots """

    def __init__(self):
        self.enable = False # Velocity charts are disabled by default. (Set True to enable.
        self.vel_data_time = 0
        self.vel_chart1 = [] # Velocity chart, for preview of velocity vs time Motor 1
        self.vel_chart2 = []  # Velocity chart, for preview of velocity vs time Motor 2
        self.vel_data_chart_t = [] # Velocity chart, for preview of velocity vs time Total V

    def reset(self):
        """ Clear data; reset for a new plot. """
        self.vel_data_time = 0
        self.vel_chart1.clear()
        self.vel_chart2.clear()
        self.vel_data_chart_t.clear()

    def rest(self, nd_ref, v_time):
        """
        Update velocity charts and plot time estimate with a zero-velocity segment for
        given time duration; typically used after raising or lowering the pen. Input in ms.
        """
        if not nd_ref.options.preview:
            return
        nd_ref.plot_status.stats.pt_estimate += v_time
        if not self.enable:
            return
        self.update(nd_ref, 0, 0, 0)
        self.vel_data_time += v_time
        self.update(nd_ref, 0, 0, 0)

    def update(self, nd_ref, v_1, v_2, v_tot):
        """ Update velocity charts, using some appropriate scaling for X and Y display."""

        if not (nd_ref.options.preview and self.enable):
            return
        temp_time = self.vel_data_time / 1000.0
        scale_factor = 10.0 / nd_ref.params.resolution
        self.vel_chart1.append(f' {temp_time:0.3f} {2.5 - v_1 / scale_factor:0.3f}')
        self.vel_chart2.append(f' {temp_time:0.3f} {2.5 - v_2 / scale_factor:0.3f}')
        self.vel_data_chart_t.append(f' {temp_time:0.3f} {2.5 - v_tot / scale_factor:0.3f}')





class Preview:
    """
    Preview: Main class for organizing preview and rendering
    """

    GROUPMODE_ATTR = '{http://www.inkscape.org/namespaces/inkscape}groupmode'
    LAYER_LABEL_ATTR = '{http://www.inkscape.org/namespaces/inkscape}label'

    def __init__(self):
        self.path_data_pu = []  # pen-up path data for preview layers
        self.path_data_pd = []  # pen-down path data for preview layers
        self.v_chart = VelocityChart()
        self.preview_pen_state = -1 # to be moved from pen handling

    def reset(self):
        """ Clear all data; reset for a new plot. """
        self.path_data_pu.clear()
        self.path_data_pd.clear()
        self.v_chart.reset()
        self.preview_pen_state = -1 # to be moved from pen handling
        self.v_chart.enable = False

    def log_sm_move(self, nd_ref, move):
        """ Log data from single "SM" move for rendering that move in preview rendering """

        if (not nd_ref.options.rendering) or (not nd_ref.params.preview_paths):
            return

        # inkex.errormsg(str(move))

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

        if self.v_chart.enable:
            vel_1 = move_steps1 / float(move_time)
            vel_2 = move_steps2 / float(move_time)
            vel_tot = plot_utils.distance(move_steps1, move_steps2) / float(move_time)
            self.v_chart.update(nd_ref, vel_1, vel_2, vel_tot)
            self.v_chart.vel_data_time += move_time
            self.v_chart.update(nd_ref, vel_1, vel_2, vel_tot)
        x_new_t = f_new_x
        y_new_t = f_new_y
        x_old_t = nd_ref.pen.phys.xpos
        y_old_t = nd_ref.pen.phys.ypos

        if nd_ref.pen.phys.z_up:
            if nd_ref.params.preview_paths > 1: # Render pen-up movement
                if nd_ref.pen.status.preview_pen_state != 1:
                    self.path_data_pu.append(f'M{x_old_t:0.3f} {y_old_t:0.3f}')
                    nd_ref.pen.status.preview_pen_state = 1
                self.path_data_pu.append(f' {x_new_t:0.3f} {y_new_t:0.3f}')
        else:
            if nd_ref.params.preview_paths in [1, 3]: # Render pen-down movement
                if nd_ref.pen.status.preview_pen_state != 0:
                    self.path_data_pd.append(f'M{x_old_t:0.3f} {y_old_t:0.3f}')
                    nd_ref.pen.status.preview_pen_state = 0
                self.path_data_pd.append(f' {x_new_t:0.3f} {y_new_t:0.3f}')


    def log_td_move(self, nd_ref, move):
        """ 
        Log data from single "TD" move for rendering that move in preview rendering 

        time, v1A, v1B, accel1, jerk1, v2A, v2B, accel2, jerk2 = td_mov

        t3_mov1 = time, v1A, 0, jerk1, v2A, 0, jerk2
        t3_mov2 = time, v1B, accel1, -jerk1, v2B, accel2, -jerk2
        """

        if (not nd_ref.options.rendering) or (not nd_ref.params.preview_paths):
            return

        # 'T3' move is formatted as:
        # ['T3', (time, velocity1, accel1, jerk1, velocity2, acccel2, jerk2), seg_data]
        # where seg_data begins with:
        #   * travel distance (inch)
        #   * xyz_pos object after move

        # move_dist = move[2][0]
        xyz_pos = move[2][1]
        f_new_x = xyz_pos.xpos
        f_new_y = xyz_pos.ypos

        mov = move[1]
        # move_time = mov[0] / 25.0 # Move time in milliseconds; there are 25k time ticks per s.

        if self.v_chart.enable:
            time = 1 # First sub-TD T3 move
            while time <= mov[0]:
                vel_1 = ebb_calc.rate_t3(time, mov[1], 0, mov[4]) * 25 / 2147483648
                vel_2 = ebb_calc.rate_t3(time, mov[5], 0, mov[8]) * 25 / 2147483648

                vel_tot = plot_utils.distance(vel_1, vel_2)
                self.v_chart.vel_data_time += 1 # Add 1 ms
                self.v_chart.update(nd_ref, vel_1, vel_2, vel_tot)
                time += 25 # Increment by 1 ms.

            time = 1 # Second sub-TD T3 move
            while time <= mov[0]:
                vel_1 = ebb_calc.rate_t3(time, mov[2], mov[3], -mov[4]) * 25 / 2147483648
                vel_2 = ebb_calc.rate_t3(time, mov[6], mov[7], -mov[8]) * 25 / 2147483648

                vel_tot = plot_utils.distance(vel_1, vel_2)
                self.v_chart.vel_data_time += 1 # Add 1 ms
                self.v_chart.update(nd_ref, vel_1, vel_2, vel_tot)
                time += 25 # Increment by 1 ms.
        x_new_t = f_new_x
        y_new_t = f_new_y
        x_old_t = nd_ref.pen.phys.xpos
        y_old_t = nd_ref.pen.phys.ypos

        if nd_ref.pen.phys.z_up:
            if nd_ref.params.preview_paths > 1: # Render pen-up movement
                if nd_ref.pen.status.preview_pen_state != 1:
                    self.path_data_pu.append(f'M{x_old_t:0.3f} {y_old_t:0.3f}')
                    nd_ref.pen.status.preview_pen_state = 1
                self.path_data_pu.append(f' {x_new_t:0.3f} {y_new_t:0.3f}')
            # inkex.errormsg("pen up...") # DEBUG
        else:
            # inkex.errormsg("pen down...") # DEBUG
            if nd_ref.params.preview_paths in [1, 3]: # Render pen-down movement
                if nd_ref.pen.status.preview_pen_state != 0:
                    self.path_data_pd.append(f'M{x_old_t:0.3f} {y_old_t:0.3f}')
                    nd_ref.pen.status.preview_pen_state = 0
                else:
                    self.path_data_pd.append(f' {x_old_t:0.3f} {y_old_t:0.3f}')

                self.path_data_pd.append(f' {x_new_t:0.3f} {y_new_t:0.3f}')


    def log_t3_move(self, nd_ref, move):
        """ Log data from single "T3" move for rendering that move in preview rendering """

        if (not nd_ref.options.rendering) or (not nd_ref.params.preview_paths):
            return

        # inkex.errormsg("At log_t3_move") # DEBUG

        # 'T3' move is formatted as:
        # ['T3', (time, velocity1, accel1, jerk1, velocity2, acccel2, jerk2), seg_data]
        # where seg_data begins with:
        #   * travel distance (inch)
        #   * xyz_pos object after move

        # move_dist = move[2][0]
        xyz_pos = move[2][1]
        f_new_x = xyz_pos.xpos
        f_new_y = xyz_pos.ypos


        mov = move[1]
        # f_new_x = move[2][0]
        # f_new_y = move[2][1]
        # move_dist = move[2][3]
        # move_time = mov[0] / 25.0 # Move time in milliseconds; there are 25k time ticks per s.
        # inkex.errormsg(f'Move time: {move_time}')

        time = 1 #
        if self.v_chart.enable:
            while time <= mov[0]:
                vel_1 = ebb_calc.rate_t3(time, mov[1], mov[2], mov[3]) * 25 / 2147483648
                vel_2 = ebb_calc.rate_t3(time, mov[4], mov[5], mov[6]) * 25 / 2147483648

                vel_tot = plot_utils.distance(vel_1, vel_2)
                self.v_chart.vel_data_time += 1 # Add 1 ms
                # print(f"vel_tot: {vel_tot}")
                self.v_chart.update(nd_ref, vel_1, vel_2, vel_tot)
                time += 1 # Increment by 1 ISR
                # time += 25 # Increment by 1 ms.

            # TODO: check units for these & re-implement
#             vel_1 = ebb_calc.rate_t3( mov[0], mov[1], mov[2], mov[3]) * 25 / 2147483648
#             vel_2 = ebb_calc.rate_t3( mov[0], mov[4], mov[5], mov[6]) * 25 / 2147483648
#             vel_tot = plot_utils.distance(vel_1, vel_2)
#             self.v_chart.vel_data_time += move_time - (time - 25)/25
#             self.v_chart.update(nd_ref, vel_1, vel_2, vel_tot)

        x_new_t = f_new_x
        y_new_t = f_new_y
        x_old_t = nd_ref.pen.phys.xpos
        y_old_t = nd_ref.pen.phys.ypos

        if nd_ref.pen.phys.z_up:
            if nd_ref.params.preview_paths > 1: # Render pen-up movement
                if nd_ref.pen.status.preview_pen_state != 1:
                    self.path_data_pu.append(f'M{x_old_t:0.3f} {y_old_t:0.3f}')
                    nd_ref.pen.status.preview_pen_state = 1
                self.path_data_pu.append(f' {x_new_t:0.3f} {y_new_t:0.3f}')

            # inkex.errormsg("pen up...") # DEBUG

        else:
            # inkex.errormsg("pen down...") # DEBUG
            if nd_ref.params.preview_paths in [1, 3]: # Render pen-down movement
                if nd_ref.pen.status.preview_pen_state != 0:
                    self.path_data_pd.append(f'M{x_old_t:0.3f} {y_old_t:0.3f}')

                # Following section -- adding sub-points to longer moves --
                #   does not render correctly when auto-rotate is active.
                #   However, it also does not appear to improve the actual
                #   render quality significantly, since our current T3 moves
                #   are essentially linear. Leaving it disabled for now.

                '''
                if mov[0] >= 75:     # for moves of at least 3 ms:
                    time = 1
                    while time < mov[0]:
                        m_1, _ = ebb_calc.move_dist_t3(time, mov[1], mov[2], mov[3])
                        m_2, _ = ebb_calc.move_dist_t3(time, mov[4], mov[5], mov[6])

    
                        motor_dist1 = float(m_1) / (nd_ref.step_scale * 2.0)
                        motor_dist2 = float(m_2) / (nd_ref.step_scale * 2.0)
                        x_delta = motor_dist1 + motor_dist2 + x_old_t # X Distance inches
                        y_delta = motor_dist1 - motor_dist2 + y_old_t # Y Distance inches
                        self.path_data_pd.append(f' { x_delta:.3f} { y_delta:.3f}')

                        # time += 125 # Increment by 5 ms.
                        # time += 250 # Increment by 10 ms.
    
                        # if mov[0] > 250:    # move longer than 10 ms:
                        #     time += mov[0] / 10
                        # else:
                        #     time += mov[0] / 3

                        time += mov[0] / 5

                    nd_ref.pen.status.preview_pen_state = 0
                '''
                self.path_data_pd.append(f' {x_new_t:0.3f} {y_new_t:0.3f}')

    def find_preview_transform(self, nd_ref):
        """
        Perform calculation to find transformation that should be applied
        to rendered previews
        """

        preview_transform = ''
        if nd_ref.rotate_page:
            if nd_ref.params.auto_rotate_ccw: # Default: Rotate counterclockwise 90 deg.
                preview_transform = 'rotate(90)'
                preview_transform += f'translate({0}, {-nd_ref.svg_width:.6E})'
            else: # Rotate 90 deg clockwise instead
                preview_transform = 'rotate(-90)'
                preview_transform += f'translate({-nd_ref.svg_height:.6E},{0})'
        s_x, s_y, o_x, o_y = nd_ref.vb_stash
        preview_transform_2 = simpletransform.formatTransform(simpletransform.parseTransform(
            f'translate({-o_x:.6E},{-o_y:.6E}) scale({1.0/s_x:.6E},{1.0/s_y:.6E})'))

        return simpletransform.formatTransform(simpletransform.composeTransform(\
                simpletransform.parseTransform(preview_transform_2),\
                simpletransform.parseTransform(preview_transform)))


    def render(self, nd_ref):
        """ Render preview layers in the SVG document """

        if not nd_ref.options.preview:
            return

        # Remove old preview layers, whenever preview mode is enabled
        for node in nd_ref.svg:
            if node.tag in ('{http://www.w3.org/2000/svg}g', 'g'):
                if node.get('{http://www.inkscape.org/namespaces/inkscape}groupmode') == 'layer':
                    layer_name = node.get('{http://www.inkscape.org/namespaces/inkscape}label')
                    if layer_name == '% Preview':
                        nd_ref.svg.remove(node)

        if (not nd_ref.options.rendering) or (not nd_ref.params.preview_paths):
            return  # If preview rendering is disabled

#         preview_transform = ''
#         if nd_ref.rotate_page:
#             if nd_ref.params.auto_rotate_ccw: # Default: Rotate counterclockwise 90 deg.
#                 preview_transform = 'rotate(90)'
#                 preview_transform += f'translate({0}, {-nd_ref.svg_width:.6E})'
#             else: # Rotate 90 deg clockwise instead
#                 preview_transform = 'rotate(-90)'
#                 preview_transform += f'translate({-nd_ref.svg_height:.6E},{0})'
#         s_x, s_y, o_x, o_y = nd_ref.vb_stash
#         preview_transform_2 = simpletransform.formatTransform(simpletransform.parseTransform(
#             f'translate({-o_x:.6E},{-o_y:.6E}) scale({1.0/s_x:.6E},{1.0/s_y:.6E})'))
# 
#         preview_transform = simpletransform.formatTransform(simpletransform.composeTransform(\
#                 simpletransform.parseTransform(preview_transform_2),\
#                 simpletransform.parseTransform(preview_transform)))


 
        preview_transform = self.find_preview_transform(nd_ref)



        path_attrs = {'transform': preview_transform}

        if nd_ref.options.digest: # Apply special transform for viewing preview in Plob.
            path_attrs = {'data-transform': preview_transform} # Save original transform.
            path_attrs['transform'] = simpletransform.formatTransform(\
                [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]) # Unity matrix

        preview_layer = etree.SubElement(nd_ref.svg, 'g', path_attrs,)
        preview_sl_u = etree.SubElement(preview_layer, 'g')
        preview_sl_d = etree.SubElement(preview_layer, 'g')
        preview_layer.set(self.GROUPMODE_ATTR, 'layer')
        preview_layer.set(self.GROUPMODE_ATTR, 'layer')
        preview_layer.set(self.LAYER_LABEL_ATTR, '% Preview')
        preview_sl_d.set(self.GROUPMODE_ATTR, 'layer')
        preview_sl_d.set(self.LAYER_LABEL_ATTR, 'Pen-down movement')
        preview_sl_u.set(self.GROUPMODE_ATTR, 'layer')
        preview_sl_u.set(self.LAYER_LABEL_ATTR, 'Pen-up movement')

        # Preview stroke width: Lesser of 1/1000 of page width or height:
        width_du = min(nd_ref.svg_width , nd_ref.svg_height) / 1000.0

        """
        Stroke-width is a css style element, and cannot accept scientific notation.

        Thus, in cases with large scaling (i.e., high values of 1/sx, 1/sy) resulting
        from the viewbox attribute of the SVG document, it may be necessary to use
        a _very small_ stroke width, so that the stroke width displayed on the screen
        has a reasonable width after being displayed greatly magnified by the viewbox.

        Use log10(the number) to determine the scale, and thus the precision needed.
        """

        if width_du == 0:
            return # Bad preview circumstances

        # Use cached, optimized precision formatting
        width_string = format_precision_width(width_du)

        p_style = {'stroke-width': width_string, 'fill': 'none',
            'stroke-linejoin': 'round', 'stroke-linecap': 'round'}

        ns_prefix = "plot"
        if nd_ref.params.preview_paths > 1:
            p_style.update({'stroke': nd_ref.params.preview_color_up})
            path_attrs = {
                'style': simplestyle.formatStyle(p_style),
                'd': " ".join(self.path_data_pu)}
            etree.SubElement(preview_sl_u, 'path', path_attrs)

        if nd_ref.params.preview_paths in (1, 3):
            p_style.update({'stroke': nd_ref.params.preview_color_down})
            path_attrs = {
                'style': simplestyle.formatStyle(p_style),
                'd': " ".join(self.path_data_pd)}
            etree.SubElement(preview_sl_d,'path', path_attrs)

        if nd_ref.params.preview_paths > 0 and self.v_chart.enable: # Preview enabled w/ velocity
            self.v_chart.vel_chart1.insert(0, "M")
            self.v_chart.vel_chart2.insert(0, "M")
            self.v_chart.vel_data_chart_t.insert(0, "M")

            p_style.update({'stroke': 'black'})
            path_attrs = {
                'style': simplestyle.formatStyle(p_style),
                'd': " ".join(self.v_chart.vel_data_chart_t),
                inkex.addNS('desc', ns_prefix): "Total V"}
            etree.SubElement(preview_layer, 'path', path_attrs)

            p_style.update({'stroke': 'red'})
            path_attrs = {
                'style': simplestyle.formatStyle(p_style),
                'd': " ".join(self.v_chart.vel_chart1),
                inkex.addNS('desc', ns_prefix): "Motor 1 V"}
            etree.SubElement(preview_layer, 'path', path_attrs)

            p_style.update({'stroke': 'green'})
            path_attrs = {
                'style': simplestyle.formatStyle(p_style),
                'd': " ".join(self.v_chart.vel_chart2),
                inkex.addNS('desc', ns_prefix): "Motor 2 V"}
            etree.SubElement(preview_layer, 'path', path_attrs)

def strip_data(nd_ref):
    ''' remove all plot and preview data from svg file '''
    svg = nd_ref.document.getroot()
    for slug in ['WCB', 'MergeData', 'plotdata', 'eggbot']:
        for node in svg.xpath('//svg:' + slug, namespaces=inkex.NSS):
            svg.remove(node)                        # Older versions of stored data element
    for node in svg.iterfind('{https://bantam.tools/nd}plotdata'):
        node.getparent().remove(node) # Current version (nextdraw)
    for node in svg.iterfind('{https://bantam.tools/ndm}data'):
        node.getparent().remove(node) # Current version (merge)
    for node in svg.xpath('//svg:' + 'g', namespaces=inkex.NSS):
        str_layer_name = node.get('{http://www.inkscape.org/namespaces/inkscape}label')
        if str_layer_name is not None:
            if str_layer_name == '% Preview':
                svg.remove(node)
