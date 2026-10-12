Stand-alone command line interface and python API
for the NextDraw writing and drawing machine.

Supported on python 3.10+, Mac, Windows, and Linux.


Copyright 2026 Windell H. Oskay, Bantam Tools

Learn more about the Bantam Tools NextDraw drawing machine at:
https://store.bantamtools.com/products/bantam-tools-nextdraw


----------


Please see Installation.txt for requirements.


----------

This directory contains the following items:

nextdraw.py                        - One way to invoke the command line interface (CLI) program

nextdraw/                          - The CLI and python module directory

documentation/                     - API documentation in HTML format

Installation.txt                  - Installation documentation

examples_python/                  - Example python scripts

examples_config/                  - Example configuration file

test/assets/NextDraw_trivial.svg   - Sample SVG file that can be plotted
----------

COMMAND LINE INTERFACE: USAGE

For detailed documentation, please refer to:
    
    https://bantam.tools/nd_cli


Quick start (CLI): 

(1) To plot an SVG document called "NextDraw_trivial.svg" from the command line,
    use the NextDraw CLI:

        nextdraw test/assets/NextDraw_trivial.svg


(2) The CLI features an extensive set of control options. For quick help, use: 

        nextdraw --help

Alternative commands (functionally identical):

        python -m nextdraw <input>

----------
    
PYTHON API: USAGE

For detailed documentation, please refer to:
    
   https://bantam.tools/nd_py/
    
Quick Start:

(1) The file "examples_python/plot.py" is an example python script, showing how
one can use a the nextdraw python module in "plot" mode to open and plot an SVG
file. 

    To run the example, call:

        python examples_python/plot.py

    This is a minimal demonstration script for opening and plotting an SVG file
    (in this case, "NextDraw_trivial.svg") from within a python script. 


(2) The file "examples_python/interactive_xy.py" is an example python script, showing how one
can use a the nextdraw python module in "interactive" mode, to execute absolute
and relative XY motion control commands like move(x,y), lineto(x,y), penup()
and pendown(). 

    To run the example, call:

        python examples_python/interactive_xy.py




----------
    

Licensing:

The NextDraw CLI and top level example scripts are licensed under the MIT license. 
Some of the underlying libraries that are included with this distribution
are licensed as GPL. Please see the individual files and directories included with
this distribution for additional license information. 

API Documentation: Copyright 2026, Windell H. Oskay, Bantam Tools



