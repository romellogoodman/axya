"""
Snap Colors - An Inkscape extension to snap colors to a defined palette.
This extension allows users to define a color palette and snap artwork colors
to the closest matching color in that palette. Optionally, it can move items
to separate layers based on their assigned colors.
"""

# Copyright 2013-2025, Windell H. Oskay, www.bantamtools.com
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 2 of the License, or
# (at your option) any later version.
#
# Portions adapted from coloreffect.py
#  Copyright (C) by Jos Hirth, kaioa.com, Aaron C. Spike, Monash University
# and from RoboPaint: https://github.com/techninja/robopaint/
# and from Post Process Trace Bitmap extension by Daniel C. Newman (from the Eggbot project)
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program; if not, write to the Free Software
# Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA

__version__ = "1.1.0"  # Dated 2025-07-14

import math
from copy import deepcopy

try:
    from plot_utils_import import from_dependency_import
except ModuleNotFoundError:
    from nextdrawcore.plot_utils_import import from_dependency_import
inkex = from_dependency_import('ink_extensions.inkex')
simplestyle = from_dependency_import('ink_extensions.simplestyle')
simpletransform = from_dependency_import('ink_extensions.simpletransform')

# pylint: disable=invalid-name

color_props = ('stroke',)


def rgba_to_rgb(rgba_decimal):
    """
    Convert a 32-bit RGBA decimal value to a list of RGB decimal values.
    Args:
        rgba_decimal (int): 32-bit unsigned integer representing RGBA color
    Returns:
        list: A list of three integers representing [R, G, B] values
    """
    red = (rgba_decimal >> 24) & 0xFF
    green = (rgba_decimal >> 16) & 0xFF
    blue = (rgba_decimal >> 8) & 0xFF
    return [red, green, blue]


def rgb_to_yuv(r, g, b):
    ''' Convert color in RGB space to one in YUV space '''
    y = r * 0.299000 + g * 0.587000 + b * 0.114000
    u = r * -.168736 + g * -.331264 + b * 0.500000 + 128
    v = r * 0.500000 + g * -.418688 + b * -.081312 + 128
    y = math.floor(y)
    u = math.floor(u)
    v = math.floor(v)
    return [y, u, v]


def is_identity(transform_matrix):
    """
    Check if a transform matrix is approximately an identity matrix.
    Args:
        transform_matrix: A 2D transform matrix in the form [[a, c, e], [b, d, f]]
                         where the transformation is represented as:
                         [a c e]
                         [b d f]
                         [0 0 1]
    Returns:
        bool: True if the matrix is approximately an identity matrix, False otherwise.
    """
    # Identity matrix values
    identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
    tolerance = 1e-5

    # Check if each element is close to the corresponding identity element
    try:
        for i in range(2):
            if len(transform_matrix) <= i or not isinstance(transform_matrix[i], list):
                return False
            row = transform_matrix[i]
            if len(row) < 3:
                return False
            for j in range(3):
                if abs(float(row[j]) - identity[i][j]) > tolerance:
                    return False
        return True
    except (IndexError, TypeError, ValueError):
        return False


class ColorSnap(inkex.Effect):
    """
    Inkscape extension to snap colors to a predefined palette.
    Optionally can move elements to layers based on their colors.
    """

    def __init__(self):
        inkex.Effect.__init__(self)
        self.arg_parser.add_argument("--tab",  # value is not used for anything. :P
                                     action="store", type=str, dest="tab", default="splash",
                                     help="The active tab when Apply was pressed")
        self.arg_parser.add_argument("--snap_layers",
                                     action="store", type=inkex.boolean_option,
                                     dest="snap_layers", default=False,
                                     help="Move colors to layers.")

        color_table = [
            (1, "1-black", 255),
            (2, "2-red", 4278190335),
            (3, "3-orange", 4289003775),
            (4, "4-yellow", 4294902015),
            (5, "5-green", 8388863),
            (6, "6-blue", 65535),
            (7, "7-violet", 2147516671),
            (8, "8-brown", 2336560127)
        ]
        for idx, layer_name, color_value in color_table:
            self.arg_parser.add_argument(f"--enable_{idx}", action="store",
                                         type=inkex.boolean_option, dest=f"enable_{idx}",
                                         default=True, help=f"Enable color {idx}")
            self.arg_parser.add_argument(f"--layer_{idx}", action="store", type=str,
                                         dest=f"layer_{idx}", default=layer_name,
                                         help=f"Layer name for color {idx}")
            self.arg_parser.add_argument(f"--color_{idx}", action="store", type=int,
                                         dest=f"color_{idx}", default=color_value,
                                         help=f"Color {idx} (32 bit int RGBA)")

        self.palette_rgb = []
        self.palette_yuv = []
        self.layer_labels = []
        self.snapped_color = -1
        self.color_values = []
        self.color_names = []
        self.layers_processed = []

    def get_composed_transform(self, node):
        """
        Get the complete composed transform from all ancestors.
        Returns a transform matrix.
        """
        # Start with identity matrix
        composed_transform = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
        # Get the node's parents up to root
        ancestors = []
        parent = node.getparent()

        while parent is not None and parent != self.document.getroot():
            ancestors.append(parent)
            parent = parent.getparent()

        # Process transforms from outermost to innermost
        for ancestor in reversed(ancestors):
            # Check for transform attribute
            transform = ancestor.get('transform')
            if transform:
                try:
                    matrix = simpletransform.parseTransform(transform)
                    composed_transform = simpletransform.composeTransform(
                        composed_transform, matrix)
                except Exception:
                    pass  # Handle invalid transform gracefully

            # Also check for transform in style attribute
            if 'style' in ancestor.attrib:
                style = ancestor.get('style')
                if style:
                    declarations = style.split(';')
                    for decl in declarations:
                        parts = decl.split(':', 2)
                        if len(parts) == 2:
                            (prop, val) = parts
                            prop = prop.strip().lower()
                            if prop == 'transform':
                                try:
                                    matrix = simpletransform.parseTransform(val.strip())
                                    composed_transform = simpletransform.composeTransform(
                                        composed_transform, matrix)
                                except Exception:
                                    pass  # Handle invalid transform gracefully
        return composed_transform

    def effect(self):
        ''' Main entry point of extension '''
        # Populate color palettes if not already populated
        if not self.palette_rgb:
            for idx in range(1, 9):
                if getattr(self.options, f"enable_{idx}"):
                    self.color_values.append(getattr(self.options, f"color_{idx}"))
                    self.color_names.append(getattr(self.options, f"layer_{idx}"))
                    self.layer_labels.append("layerNotFound")
                    rgba_int = getattr(self.options, f"color_{idx}")
                    rgb_values = rgba_to_rgb(rgba_int)
                    hex_color = f"#{rgb_values[0]:02x}{rgb_values[1]:02x}{rgb_values[2]:02x}"
                    self.palette_rgb.append(hex_color)
            for color in self.color_values:
                color_rgb = rgba_to_rgb(color)
                self.palette_yuv.append(rgb_to_yuv(color_rgb[0], color_rgb[1], color_rgb[2]))
        if not self.palette_rgb:  # Exit if no colors to process
            return

        # Process the document for color snapping and find existing layers
        if self.options.ids:
            # Process only selected objects
            for one_id in self.options.ids:
                self.get_attribs(self.selected[one_id])
        else:
            # Process entire document
            self.get_attribs(self.document.getroot())
        if not self.options.snap_layers:
            return

        # Create a mapping of color index to layer element
        color_to_layer = {}
        created_layers = []

        # One-time scan of document root to find existing layers
        for child in self.document.getroot():
            if child.get(inkex.addNS('groupmode', 'inkscape')) == 'layer':
                layer_name = child.get(inkex.addNS('label', 'inkscape'))
                if layer_name in self.color_names:
                    color_idx = self.color_names.index(layer_name)
                    self.layer_labels[color_idx] = layer_name
                    color_to_layer[color_idx] = child

        # Create missing layers for each color
        for i in range(len(self.color_names)):
            if i not in color_to_layer:
                layer = inkex.etree.SubElement(
                    self.document.getroot(), inkex.addNS('g', 'svg'))
                layer.set(inkex.addNS('groupmode', 'inkscape'), 'layer')
                layer.set(inkex.addNS('label', 'inkscape'), self.color_names[i])
                self.layer_labels[i] = self.color_names[i]
                color_to_layer[i] = layer
                created_layers.append(i)

        # Move colored nodes to appropriate layers
        for i, layer in color_to_layer.items():
            if self.color_names[i] not in self.layers_processed:
                self.layers_processed.append(self.color_names[i])
                if self.options.ids:
                    # Process only selected objects
                    for one_id in self.options.ids:
                        self.move_colored_nodes(self.selected[one_id], layer, i)
                else:
                    # Process entire document
                    self.move_colored_nodes(self.document.getroot(), layer, i)

        # Remove empty created layers
        for i in created_layers:
            layer = color_to_layer.get(i)
            if layer is not None and len(layer) == 0:
                self.document.getroot().remove(layer)

    def get_layer_transform(self, layer):
        """ Get the transform of a layer. """
        transform = layer.get('transform')
        if transform:
            try:
                return simpletransform.parseTransform(transform)
            except Exception:
                pass
        # Also check for transform in style attribute
        if 'style' in layer.attrib:
            style = layer.get('style')
            if style:
                declarations = style.split(';')
                for decl in declarations:
                    parts = decl.split(':', 2)
                    if len(parts) == 2:
                        (prop, val) = parts
                        prop = prop.strip().lower()
                        if prop == 'transform':
                            try:
                                return simpletransform.parseTransform(val.strip())
                            except Exception:
                                pass

        # Return identity matrix if no transform found
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]

    def move_colored_nodes(self, node, destination, layer_no_int):
        ''' Move items with identified color to identified layers '''
        val = node.get('snap-color-layer')
        if val:
            try:
                if int(val) == layer_no_int:
                    parent = node.getparent()
                    if parent is not None and layer_no_int < len(self.layer_labels):
                        # Only proceed if the node isn't already in the right layer
                        if parent.get(inkex.addNS('label', 'inkscape')) != \
                                self.layer_labels[layer_no_int]:
                            ancestor_transform = self.get_composed_transform(node)
                            dest_layer_transform = self.get_layer_transform(destination)
                            node_copy = deepcopy(node)
                            node_transform = node_copy.get('transform')
                            if node_transform:  # Calculate final transform
                                try:
                                    # Parse node's transform
                                    node_matrix = simpletransform.parseTransform(node_transform)
                                    # Combine with ancestor transform
                                    complete_transform = simpletransform.composeTransform(
                                        ancestor_transform, node_matrix)
                                    # Invert destination layer transform to compensate
                                    inv_dest_transform = simpletransform.invertTransform(
                                        dest_layer_transform)
                                    # Apply compensation to get the correct final transform
                                    final_matrix = simpletransform.composeTransform(
                                        inv_dest_transform, complete_transform)
                                except:
                                    # If there's any error, fall back to using ancestor transform
                                    # with destination layer compensation
                                    try:
                                        inv_dest_transform = simpletransform.invertTransform(
                                            dest_layer_transform)
                                        final_matrix = simpletransform.composeTransform(
                                            inv_dest_transform, ancestor_transform)
                                    except:
                                        # Ultimate fallback: use ancestor transform directly
                                        final_matrix = ancestor_transform
                            else:
                                # No node transform, just use ancestor transform with compensation
                                try:
                                    inv_dest_transform = simpletransform.invertTransform(
                                        dest_layer_transform)
                                    final_matrix = simpletransform.composeTransform(
                                        inv_dest_transform, ancestor_transform)
                                except:
                                    final_matrix = ancestor_transform
                            # Apply the final transform only if it's not identity
                            if not is_identity(final_matrix):
                                node_copy.set('transform',
                                              simpletransform.formatTransform(final_matrix))
                            else:
                                # If final transform is identity, remove transform attribute
                                if 'transform' in node_copy.attrib:
                                    del node_copy.attrib['transform']
                            destination.append(node_copy)
                            parent.remove(node)
            except (ValueError, IndexError, TypeError):
                # Handle any errors gracefully
                pass

        # Process child nodes
        for branch in list(node):  # Use list to avoid modification during iteration
            self.move_colored_nodes(branch, destination, layer_no_int)

    def scan_for_layer_names(self, node):
        ''' Recursive search for items with layer names '''
        self.parse_layer_name(node)
        for child in node:
            self.scan_for_layer_names(child)

    def parse_layer_name(self, node):
        ''' Read and process layer name '''
        if node.get(inkex.addNS('groupmode', 'inkscape')) == 'layer':
            layer_name = node.get(inkex.addNS('label', 'inkscape'))

            # Check if this layer name exactly matches any of our color names
            if layer_name in self.color_names:
                idx = self.color_names.index(layer_name)
                self.layer_labels[idx] = layer_name

    def get_attribs(self, node):
        ''' Update styles and get attributes '''
        self.change_style(node)
        for child in node:
            self.get_attribs(child)

    def change_style(self, node):
        ''' Read and update style information on a node '''
        self.snapped_color = -1
        for attr in color_props:
            val = node.get(attr)
            if val:
                new_val = self.process_prop(val)
                if new_val != val:
                    node.set(attr, new_val)
                if self.snapped_color != -1:
                    node.attrib["snap-color-layer"] = str(self.snapped_color)

        if 'style' in node.attrib:
            # References for style attribute:
            # http://www.w3.org/TR/SVG11/styling.html#StyleAttribute,
            # http://www.w3.org/TR/CSS21/syndata.html
            #
            # The SVG spec is ambiguous as to how style attributes should be parsed.
            # For example, it isn't clear whether semicolons are allowed to appear
            # within strings or comments, or indeed whether comments are allowed to
            # appear at all.
            #
            # The processing here is just something simple that should usually work,
            # without trying too hard to get everything right.
            # (Won't work for the pathological case that someone escapes a property
            # name, probably does the wrong thing if colon or semicolon is used inside
            # a comment or string value.)
            self.snapped_color = -1
            style = node.get('style')  # Not compatible with presentation attributes...
            if style:
                declarations = style.split(';')
                for i, decl in enumerate(declarations):
                    parts = decl.split(':', 2)
                    if len(parts) == 2:
                        (prop, val) = parts
                        prop = prop.strip().lower()
                        if prop in color_props:
                            val = val.strip()
                            new_val = self.process_prop(val)
                            if new_val != val:
                                declarations[i] = prop + ':' + new_val
                                node.set('style', ';'.join(declarations))
                            if self.snapped_color != -1:
                                node.attrib["snap-color-layer"] = str(self.snapped_color)

    def process_prop(self, col):
        ''' identify valid color values and process them '''
        if simplestyle.isColor(col):
            c = simplestyle.parseColor(col)
            col = '#' + self.colmod(c[0], c[1], c[2])  # Format as hex value
        return col

    def colmod(self, r, g, b):
        ''' Modify color, snapping it to nearest value '''
        closest_idx = self.closest_color(r, g, b)  # Snap to nearest color in the palette
        if closest_idx < 0 or closest_idx >= len(self.palette_rgb):  # Invalid index
            return f"{r:02x}{g:02x}{b:02x}"  # Return the original color
        hex_color = self.palette_rgb[closest_idx]  # Get the hex color at that index
        rgb = simplestyle.parseColor(hex_color)  # Parse it back to RGB
        return f"{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"  # Return formatted hex string

    def closest_color(self, r, g, b):
        ''' Identify closest color in our palette. '''
        if not self.palette_yuv:
            self.snapped_color = -1
            return -1
        yuv = rgb_to_yuv(r, g, b)
        lowest_index = 0
        lowest_value = 1000

        for i in range(len(self.palette_rgb)):
            c = self.palette_yuv[i]
            # Calculate color distance
            distance = math.sqrt(
                math.pow(c[0] - yuv[0], 2) +
                math.pow(c[1] - yuv[1], 2) +
                math.pow(c[2] - yuv[2], 2)
            )
            if distance < lowest_value:
                lowest_value = distance
                lowest_index = i

        self.snapped_color = lowest_index
        return lowest_index


if __name__ == '__main__':
    e = ColorSnap()
    e.affect()
