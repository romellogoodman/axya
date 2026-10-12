#!/usr/bin/env python

'''
interactive_xy.py

Demonstrate use of nextdraw module in "interactive" mode.

Run this demo by calling: python interactive_xy.py


---------------------------------------------------------------------

About the interactive API:

Interactive mode is a mode of use, designed for plotting individual motion
segments upon request, using direct XY control. It is a complement to the
usual plotting modes, which take an SVG document as input.

So long as the NextDraw is started in the home corner, moves are limit checked,
and constrained to be within the safe travel range of the NextDraw.


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

from nextdraw import NextDraw

nd1 = NextDraw() # Initialize class

nd1.interactive()            # Enter interactive mode
connected = nd1.connect()    # Open serial port to NextDraw

if not connected:
    print("Not connected to machine; exiting.")
    sys.exit() # end script

# Draw square, using "moveto/lineto" (absolute move) syntax:

nd1.moveto(1, 1)              # Absolute pen-up move, to (1 inch, 1 inch)
nd1.lineto(2, 1)              # Absolute pen-down move, to (2 inches, 1 inch)
nd1.lineto(2, 2)
nd1.lineto(1, 2)
nd1.lineto(1, 1)              # Finish drawing square
nd1.moveto(0, 0)              # Absolute pen-up move, back to origin.

nd1.delay(2000)              # Delay 2 seconds

# Change some options:
nd1.options.units = 1              # set working units to cm.
nd1.options.speed_pendown = 10     # set pen-down speed to slow
nd1.options.pen_pos_up = 50        # select a large range for the pen up/down swing
nd1.options.pen_pos_down = 10

nd1.update()                 # Process changes to options

# Draw an "X" through the square, using "move/line" (relative move) syntax:
# Note that we have just changed the units to be in cm.

nd1.move(5.08, 5.08)          # Relative move to (2 inches,2 inches), in cm
nd1.line(-2.54, -2.54)        # Relative move 2.54 cm in X and Y
nd1.move(0, 2.54)
nd1.line(2.54, -2.54)         # Relative move 2.54 cm in X and Y

nd1.moveto(0, 0)              # Return home


# Change some options, just to show how we do so:
nd1.options.units = 0        # set working units back to inches.
nd1.options.speed_pendown = 75     # set pen-down speed to fast
nd1.options.pen_rate_lower = 10 # Set pen down very slowly
nd1.update()                 # Process changes to options


# Draw a "+" through the square, using "go/goto" commands,
# which do not automatically set the pen up or down:

nd1.goto(1.5, 1.0)
nd1.pendown()
nd1.go(0,1)
nd1.penup()
nd1.goto(1.0, 1.5)
nd1.pendown()
nd1.go(1,0)
nd1.penup()

nd1.goto(0, 0)                # Return home

nd1.disconnect()             # Close serial port to NextDraw
