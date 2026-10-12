'''
plot.py

Demonstrate use of nextdraw module in "plot" mode, to plot an SVG file.

Run this demo by calling: python plot.py


This is a minimal example to show how one can import the NextDraw module
and use it to plot an SVG file with the NextDraw.

(There is also a separate "interactive" mode, which can be used for moving
the NextDraw to various points upon command, rather than plotting an SVG file.)

---------------------------------------------------------------------

NextDraw python API documentation is hosted at: https://bantam.tools/nd_py/

---------------------------------------------------------------------

About this software:

The Bantam Tools NextDraw (TM) drawing machine is a product of Bantam Tools.
https://bantamtools.com

This open source software is written and maintained by Bantam Tools
to support Bantam Tools users across a wide range of applications.
Please help support Bantam Tools and open source software development by
purchasing genuine Bantam Tools NextDraw hardware.

Full user guide for this Python API:
    https://bantam.tools/nd_py/

Additional NextDraw documentation is available at http://bantam.tools/nddocs

NextDraw owners may request technical support for this software through our
various support channels, listed at: http://bantam.tools/ndcontact


---------------------------------------------------------------------

This example script:
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

import sys
import os.path
from nextdraw import NextDraw

nd1 = NextDraw()             # Create class instance

'''
Try a few different possible locations for our file,
so that this can be called from either the root or examples_python directory,
or if you're in the same directory with the file.
'''

LOCATION1 = "test/assets/NextDraw_trivial.svg"
LOCATION2 = "../test/assets/NextDraw_trivial.svg"
LOCATION3 = "NextDraw_trivial.svg"

FILE = None

if os.path.exists(LOCATION1):
    FILE = LOCATION1
if os.path.exists(LOCATION2):
    FILE = LOCATION2
if os.path.exists(LOCATION3):
    FILE = LOCATION3

if FILE:
    print("Example file located at: " + FILE)
    nd1.plot_setup(FILE)    # Parse the input file
else:
    print("Unable to locate example file; exiting.")
    sys.exit() # end script

# The above code, starting with "LOCATION1" can all be replaced by a single line
# if you already know where the file is. This can be as simple as:
# nd1.plot_setup("NextDraw_trivial.svg")

nd1.options.speed_pendown = 50 # Set maximum pen-down speed to 50%

'''
See documentation for a description of additional options and their allowed values
'''

nd1.plot_run()   # plot the document
