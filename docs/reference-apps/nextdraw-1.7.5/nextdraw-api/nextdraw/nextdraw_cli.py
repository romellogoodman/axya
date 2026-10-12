'''
nextdraw - Command Line Interface (CLI) for the Bantam Tools NextDraw™.

For quick help:
    nextdraw --help

Full user guide:
    https://bantam.tools/nd_cli/

This script is a stand-alone version of the Bantam Tools NextDraw software, accepting
various options and providing a facility for setting default values.

Requires Python 3.9 or newer

See __version__ below for current version and date.

###############################

About this software:

The Bantam Tools NextDraw™ drawing machine is a product of Bantam Tools.
https://bantamtools.com

This open source software is written and maintained by Bantam Tools
to support Bantam Tools users across a wide range of applications.
Please help support Bantam Tools and open source software development by
purchasing genuine Bantam Tools NextDraw hardware.

Full user guide for this software:
    https://bantam.tools/nd_cli/

Additional NextDraw documentation is available at http://bantam.tools/nddocs

NextDraw owners may request technical support for this software through our
various support channels, listed at: http://bantam.tools/ndcontact



Copyright 2026 Windell H. Oskay, Bantam Tools

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

__version__ = '1.7.5'  # Dated 2026-10-07

import argparse
import copy
import sys
from lxml import etree
import nextdraw
from nextdraw import utils

from plotink.plot_utils_import import from_dependency_import  # plotink
exit_status = from_dependency_import("ink_extensions_utils.exit_status")

cli_version = "Bantam Tools NextDraw™ Command Line Interface " + __version__

quick_help = '''
    Bantam Tools NextDraw™ Command Line Interface

    Basic syntax to plot a file:      nextdraw svg_in [OPTIONS]
    For a quick list of options, use: nextdraw --help
    To display current version, use:  nextdraw --version

    For full user guide, please see: https://bantam.tools/nd_cli/

    Copyright 2026 Bantam Tools.
        '''


def nextdraw_CLI(dev=False):
    ''' The core of the NextDraw CLI API '''

    desc = 'Bantam Tools NextDraw™ Command Line Interface.'

    parser = argparse.ArgumentParser(description=desc, usage=quick_help)

    parser.add_argument("svg_in", nargs='?', help="The SVG file to be plotted")

    parser.add_argument("-f", "--config", type=str, dest="config",
                        help="Filename for custom configuration file.")

    parser.add_argument("-m", "--mode",
                        metavar='MODENAME', type=str,
                        help="Mode. One of: [plot, layers, align, cycle, find_home, utility, "
                        + "sysinfo, version, res_plot]. Default: plot.")

    parser.add_argument("-s", "--speed_pendown",
                        metavar='SPEED',  type=int,
                        help="Maximum plotting speed, when pen is down (1-100)")

    parser.add_argument("-S", "--speed_penup",
                        metavar='SPEED', type=int,
                        help="Maximum transit speed, when pen is up (1-100)")

    parser.add_argument("-a", "--accel",
                        metavar='RATE', type=int,
                        help="Acceleration rate factor (1-100)")

    parser.add_argument("-d", "--pen_pos_down",
                        metavar='HEIGHT', type=int,
                        help="Height of pen when lowered (0-100)")

    parser.add_argument("-u", "--pen_pos_up",
                        metavar='HEIGHT', type=int,
                        help="Height of pen when raised (0-100)")

    parser.add_argument("-r", "--pen_rate_lower",
                        metavar='RATE', type=int,
                        help="Rate of lowering pen (1-100)")

    parser.add_argument("-R", "--pen_rate_raise",
                        metavar='RATE', type=int,
                        help="Rate of raising pen (1-100)")

    parser.add_argument("-N", "--no_rotate",
                        action="store_true",
                        help="Disable auto-rotate; preserve plot orientation")

    parser.add_argument("-n", "--no_homing",
                        action="store_true",
                        help="Disable automatic homing")

    parser.add_argument("-T", "--report_time",
                        action="store_true",
                        help="Report time elapsed")

    parser.add_argument("-M", "--utility_cmd",
                        metavar='COMMAND', type=str,
                        help="Utility command. One of: [lower_pen, raise_pen, toggle, set_home, "
                        + "walk_x, walk_y, walk_mmx, walk_mmy, walk_home, enable_xy, disable_xy, "
                        + "res_read, res_adj_in (deprecated), res_adj_mm (deprecated), bootload, "
                        + "strip_data, read_name, list_names, write_name]. Default: read_name")

    parser.add_argument("-z", "--handling",
                        type=int, metavar='HANDLING_MODE',
                        help="Select Handling mode (1-4)."
                        + "1: Technical drawing. "
                        + "2: Handwriting. "
                        + "3: Sketching. "
                        + "4: Constant speed. ")

    parser.add_argument("-w", "--dist",
                        metavar='DISTANCE', type=str,
                        help="Distance for utility-mode walks or offset_start. "
                        + "Supports unit suffixes: 5in, 5mm, 5cm. "
                        + "Without suffix, uses command's native unit.")

    parser.add_argument("--offset_start",
                        action="store_true",
                        help="Start plotting from offset position specified by --dist. "
                        + "For plot/layers: offset from file beginning (dist >= 0). "
                        + "For res_plot: relative to saved position (can be negative).")

    parser.add_argument("-l", "--layer",
                        type=int,
                        help="Layer(s) selected for layers mode (1-1000). Default: 1")

    parser.add_argument("-c", "--copies",
                        metavar='COUNT', type=int,
                        help="Copies to plot, or 0 for continuous plotting. Default: 1")

    parser.add_argument("-D", "--page_delay",
                        metavar='DELAY', type=int,
                        help="Optional delay between copies (s).")

    parser.add_argument("-v", "--preview",
                        action="store_true",
                        help="Preview mode; simulate plotting only.")

    parser.add_argument("-g", "--no_render",
                        action="store_true",
                        help="Disable rendering in preview mode.")

    parser.add_argument("-G", "--reordering",
                        metavar='VALUE', type=int,
                        help="SVG reordering option (0-4; 3 deprecated)."
                        + " 0: Least; Only connect adjoining paths."
                        + " 1: Basic; Also reorder paths for speed."
                        + " 2: Full; Also allow path reversal."
                        + " 4: None; Strictly preserve file order.")

    parser.add_argument("-Y", "--random_start",
                        action="store_true",
                        help="Randomize start position of closed paths.")

    parser.add_argument("-H", "--hiding",
                        action="store_true",
                        help="Enable hidden-line removal")

    parser.add_argument("-L", "--model",
                        metavar='MODELCODE', type=int,
                        help="Model (1-10). "
                        + "1: AxiDraw V2 or V3. "
                        + "2: AxiDraw V3/A3 or SE/A3. 3: AxiDraw V3 XLX. "
                        + "4: AxiDraw MiniKit. 5: AxiDraw SE/A1. 6: AxiDraw SE/A2. "
                        + "7: AxiDraw V3/B6. "
                        + "8: Bantam Tools NextDraw™ 8511 (Default). "
                        + "9: Bantam Tools NextDraw™ 1117. "
                        + "10: Bantam Tools NextDraw™ 2234. ")

    parser.add_argument("-q", "--penlift",
                        metavar='LIFTCODE', type=int,
                        help="Pen lift servo configuration (1-3). "
                        + "1: Default for NextDraw model. "
                        + "3: Brushless upgrade.")

    parser.add_argument("-p", "--port",
                        metavar='PORTNAME', type=str,
                        help="Serial port or named NextDraw to use")

    parser.add_argument("-P", "--port_config",
                        metavar='PORTCODE', type=int,
                        help="Port use code (0-3)."
                        + " 0: Plot to first unit found, unless port is specified"
                        + " 1: Plot to first NextDraw Found."
                        + " 2: Plot to specified NextDraw."
                        + " 3: Plot to all NextDraw units.")

    parser.add_argument("-o", "--output_file",
                        metavar='FILE',
                        help="SVG output file name")

    parser.add_argument("-O", "--digest",
                        metavar='VALUE', type=int,
                        help="Plot digest output option (0-2)."
                        + " 0: No change to behavior or output (Default)."
                        + " 1: Output 'plob' digest, not full SVG, when saving file."
                        + " 2: Disable plots and previews; generate digest only.")

    parser.add_argument("-W", "--webhook",
                        action="store_true",
                        help='Enable webhook notifications')

    parser.add_argument("-U", "--webhook_url",
                        metavar='URL', type=str,
                        help="URL for webhook alerts")

    parser.add_argument("--version",
                        action='store_true',
                        help="Output the NextDraw CLI version number")

    parser.add_argument("-b", "--progress",
                        action="store_true",
                        help='Enable CLI progress bar while plotting')

    args = parser.parse_args()

    # Handle cases of `store_true` elements; ensure that they are only True if asserted.
    for arg_name in ["webhook", "progress", "report_time", "preview", "random_start", "hiding",
                     "offset_start"]:
        if not getattr(args, arg_name):
            setattr(args, arg_name, None)

    # Handle specific "simple flag" CLI options that are not in the core:
    if args.no_rotate:  # Override regular auto_rotate option
        args.auto_rotate = False
        del vars(args)['no_rotate']  # Remove original argument

    if args.no_homing:  # Override regular homing option
        vars(args)['homing'] = False
        del vars(args)['no_homing']  # Remove original argument

    if args.no_render:  # Override regular preview rendering option
        args.rendering = False
        del vars(args)['no_render']  # Remove original argument

    # Handle trivial cases
    nd1 = nextdraw.NextDraw()

    info_mode = "version" if args.version else args.svg_in
    utils.handle_info_cases(info_mode, quick_help, cli_version, "NextDraw", nd1.version_string)

    if args.mode == "options":
        quit()

    # Detect certain "trivial" cases that do not require an input file
    use_trivial_file = False
    if args.mode in ("setup", "align", "toggle", "cycle", "version", "sysinfo", "find_home"):
        use_trivial_file = True
    if args.mode == "utility" and args.utility_cmd not in\
            ("strip_data", "res_read", "res_adj_in", "res_adj_mm"):
        use_trivial_file = True

    svg_input = args.svg_in

    if not use_trivial_file or args.output_file:
        utils.check_for_input(svg_input,
            """usage: nextdraw svg_in [OPTIONS]
    Input file required but not found.
    For help, use: nextdraw --help""")

    #  For nontrivial cases, import the nextdraw module and go from there:

    config_dict = utils.load_configs([args.config, 'nextdrawcore.nextdraw_conf'])
    combined_config = utils.FakeConfigModule(config_dict)

    from nextdrawcore import nextdraw_control

    ndc = nextdraw_control.NextDrawWrapperClass(params=combined_config)

    ndc.getoptions([])

    if use_trivial_file:
        trivial_svg = """<?xml version="1.0" encoding="UTF-8" standalone="no"?>
            <svg
               xmlns:dc="http://purl.org/dc/elements/1.1/"
               xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
               xmlns:svg="http://www.w3.org/2000/svg"
               xmlns="http://www.w3.org/2000/svg"
               version="1.1"
               id="svg15158"
               viewBox="0 0 297 210"
               height="210mm"
               width="297mm">
            </svg>
            """
        svg_string = trivial_svg.encode('utf-8')  # Need consistent encoding.
        p = etree.XMLParser(huge_tree=True, encoding='utf-8')
        ndc.document = etree.ElementTree(etree.fromstring(svg_string, parser=p))
        ndc.original_document = copy.deepcopy(ndc.document)
    else:
        utils.effect_parse(ndc, svg_input)

    # assign command line options to ndc's options.
    # additionally, look inside the config to see if any command line options were set there
    option_names = utils.OPTION_NAMES
    utils.assign_option_values(ndc.options, args, [config_dict], option_names)

    ndc.cli_api = True  # Set flag that this is being called from the CLI.

    exit_status.run(ndc.effect)    # Plot the document
    if utils.has_output(ndc) and not use_trivial_file:
        utils.output_result(args.output_file, ndc.outdoc)

    if ndc.status_code >= 100:  # Give non-zero exit code.
        sys.exit(1)  # No need to be more verbose; we have already printed error messages.

    return ndc if dev else None  # returning ndc is useful for tests
