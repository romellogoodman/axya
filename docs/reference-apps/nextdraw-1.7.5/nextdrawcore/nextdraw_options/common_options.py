'''
Copyright 2025 Windell H. Oskay, Bantam Tools
Part of the NextDraw driver software
http://bantamtools.com
'''

import argparse

from nextdrawcore.plot_utils_import import from_dependency_import # plotink
inkex = from_dependency_import('ink_extensions.inkex')

def core_nextdraw_options(config):
    mode_options = core_mode_options(config)
    options = core_options(config)
    return argparse.ArgumentParser(add_help = False, parents = [mode_options, options])

def core_options(config):
    ''' options that are used in extensions in this library, as well as in consumers of it '''

    options = argparse.ArgumentParser(add_help = False) # parent parser

    options.add_argument("--speed_pendown",\
                        type=int, action="store", dest="speed_pendown", \
                        default=config["speed_pendown"], \
                        help="Maximum plotting speed, when pen is down (1-100)")

    options.add_argument("--speed_penup",\
                        type=int, action="store", dest="speed_penup", \
                        default=config["speed_penup"], \
                        help="Maximum transit speed, when pen is up (1-100)")

    options.add_argument("--accel",\
                        type=int, action="store", dest="accel", \
                        default=config["accel"], \
                        help="Acceleration rate factor (1-100)")

    options.add_argument("--pen_pos_down",\
                        type=int, action="store", dest="pen_pos_down",\
                        default=config["pen_pos_down"],\
                        help="Height of pen when lowered (0-100)")

    options.add_argument("--pen_pos_up",\
                        type=int, action="store", dest="pen_pos_up", \
                        default=config["pen_pos_up"], \
                        help="Height of pen when raised (0-100)")

    options.add_argument("--pen_rate_lower",\
                        type=int, action="store", dest="pen_rate_lower",\
                        default=config["pen_rate_lower"], \
                        help="Rate of lowering pen (1-100)")

    options.add_argument("--pen_rate_raise",\
                        type=int, action="store", dest="pen_rate_raise",\
                        default=config["pen_rate_raise"],\
                        help="Rate of raising pen (1-100)")

    options.add_argument("--report_time",\
                        type=inkex.boolean_option, action="store", dest="report_time",\
                        default=config["report_time"],\
                        help="Report time elapsed")

    options.add_argument("--homing",\
                        type=inkex.boolean_option, action="store", dest="homing",\
                        default=config["homing"],\
                        help="Enable automatic homing, where supported.")

    options.add_argument("--page_delay",\
                        type=int, action="store", dest="page_delay",\
                        default=config["page_delay"],\
                        help="Optional delay between copies (s).")

    options.add_argument("--preview",\
                        type=inkex.boolean_option, action="store", dest="preview",\
                        default=config["preview"],\
                        help="Preview mode; simulate plotting only.")

    options.add_argument("--rendering",\
                        type=inkex.boolean_option, action="store", dest="rendering",\
                        default=config["rendering"],\
                        help="Enable rendering when running previews")

    options.add_argument("--model",\
                        type=int, action="store", dest="model",\
                        default=config["model"],\
                        help="Model (1-10). " \
                        + "8: Bantam Tools NextDraw 8511 (Default). " \
                        + "9: Bantam Tools NextDraw 1117. " \
                        + "10: Bantam Tools NextDraw 2234. " \
                        + "1: AxiDraw V2 or V3. " \
                        + "2: AxiDraw V3/A3 or SE/A3. 3: AxiDraw V3 XLX. " \
                        + "4: AxiDraw MiniKit. 5: AxiDraw SE/A1. 6: AxiDraw SE/A2." \
                        + "7: AxiDraw V3/B6. ")

    options.add_argument("--penlift",\
                        type=int, action="store", dest="penlift",\
                        default=config["penlift"],\
                        help="pen lift motor configuration (1 or 3). " \
                        + "1: Default for model. " \
                        + "3: Brushless upgrade.")

    options.add_argument("--port_config",\
                        type=int, action="store", dest="port_config",\
                        default=config["port_config"],\
                        help="Port use code (0-3)."\
                        +" 0: Plot to first unit found, unless port is specified."\
                        + "1: Plot to first unit Found. "\
                        + "2: Plot to specified machine. "\
                        + "3: Plot to all machines. ")

    options.add_argument("--port",\
                        type=str, action="store", dest="port",\
                        default=config["port"],\
                        help="Machine name or serial port")

    options.add_argument("--setup_type",\
                        type=str, action="store", dest="setup_type",\
                        default="align",\
                        help="Setup option selected (GUI Only)")

    options.add_argument("--auto_rotate",\
                        type=inkex.boolean_option, action="store", dest="auto_rotate",\
                        default=config["auto_rotate"], \
                        help="Auto select portrait vs landscape orientation")

    options.add_argument("--random_start",\
                        type=inkex.boolean_option, action="store", dest="random_start",\
                        default=config["random_start"], \
                        help="Randomize start locations of closed paths")

    options.add_argument("--hiding",\
                        type=inkex.boolean_option, action="store", dest="hiding",\
                        default=config["hiding"], \
                        help="Hidden-line removal")

    options.add_argument("--reordering",\
                        type=int, action="store", dest="reordering",\
                        default=config["reordering"],\
                        help="SVG reordering option (0-4; 3 deprecated)."\
                        + " 0: Least: Only connect adjoining paths."\
                        + " 1: Basic: Also reorder paths for speed."\
                        + " 2: Full: Also allow path reversal."\
                        + " 4: None: Strictly preserve file order.")

    options.add_argument("--digest",\
                        type=int, action="store", dest="digest",\
                        default=config["digest"],\
                        help="Plot optimization option (0-2)."\
                        + "0: No change to behavior or output (Default)."\
                        + "1: Output 'plob' digest, not full SVG, when saving file. "\
                        + "2: Disable plots and previews; generate digest only. ")

    options.add_argument("--webhook",\
                        type=inkex.boolean_option, action="store", dest="webhook",\
                        default=config["webhook"],\
                        help="Enable webhook callback when a plot finishes")

    options.add_argument("--webhook_url",\
                        type=str, action="store", dest="webhook_url",\
                        default=config["webhook_url"],\
                        help="Webhook URL to be used if webhook is enabled")

    options.add_argument("--submode",\
                        action="store", type=str, dest="submode",\
                        default="none", \
                        help="Secondary GUI tab.")

    options.add_argument("--handling",\
                        type=int, action="store", dest="handling",\
                        default=config["handling"],\
                        help="Handling mode (1-4)."\
                        + "1: Technical drawing. "\
                        + "2: Handwriting. "\
                        + "3: Sketching. "\
                        + "4: Constant speed. ")

    return options

def core_mode_options(config):
    ''' these are also common options, but unlike options in `core_options`, these
    are options that are more specific to this repo '''
    options = argparse.ArgumentParser(add_help = False) # parent parser

    options.add_argument("--mode",\
                        action="store", type=str, dest="mode",\
                        default=config["mode"], \
                        help="Mode or GUI tab. One of: [plot, layers, align, toggle, cycle"\
                        + ", find_home, utility, sysinfo, version, res_plot]. Default: plot.")

    options.add_argument("--utility_cmd",\
                        type=str, action="store", dest="utility_cmd",\
                        default=config["utility_cmd"],\
                        help="Utility command. One of: [raise_pen, lower_pen, set_home,"\
                        + "walk_x, walk_y, walk_mmx, walk_mmy, walk_home, enable_xy, "\
                        + "disable_xy, res_read, res_adj_in, res_adj_mm, bootload, "\
                        + "strip_data, read_name, list_names, write_name]. Default: read_name")

    options.add_argument("--dist",\
                        type=str, action="store", dest="dist",\
                        default=str(config["dist"]),\
                        help="Distance for utility-mode walks or changing resume position. ")

    options.add_argument("--offset_start",\
                        action="store_true", dest="offset_start",\
                        default=config["offset_start"],\
                        help="Start plotting from offset position specified by --dist. "\
                        + "For plot/layers: offset from file beginning (dist >= 0). "\
                        + "For res_plot: relative to saved position (can be negative). "\
                        + "Ignored for other modes. Default: False")

    options.add_argument("--layer",\
                        type=int, action="store", dest="layer",\
                        default=config["default_layer"],\
                        help="Layer(s) selected for layers mode (1-1000). Default: 1")

    options.add_argument("--layer_option",\
                        type=int, action="store", dest="layer_option",\
                        default=1,\
                        help="Layer use option (1-2)."\
                        + "1: Plot entire document. "\
                        + "2: Plot selected layers. ")

    options.add_argument("--copies",\
                        type=int, action="store", dest="copies",\
                        default=config["copies"],\
                        help="Copies to plot, or 0 for continuous plotting. Default: 1")

    return options
