'''
turtle_pos.py

Demonstrate use of nextdraw module in "interactive" mode, showing how out-of-bounds
motion is handled, and demonstrating the interactive-mode query functions,
current_pos, turtle_pos, current_pen, turtle_pen

Run this demo by calling: python turtle_pos.py


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

def print_position():
    '''
    Query, report, and print position and pen state
    '''
    turtle_position = nd1.turtle_pos()
    current_position = nd1.current_pos()
    print(f"Turtle: {turtle_position[0]:0.3f}, {turtle_position[1]:0.3f}")
    print(f"Actual: {current_position[0]:0.3f}, {current_position[1]:0.3f}")
    turtle_pen_state = nd1.turtle_pen()
    current_pen_state = nd1.current_pen()
    print("Turtle pen up: " + str(turtle_pen_state))
    print("Actual pen up: " + str(current_pen_state) + "\n")

nd1.interactive()            # Enter interactive mode
connected = nd1.connect()    # Open serial port to NextDraw

if not connected:
    print("Not connected to machine; exiting.")
    sys.exit() # end script

nd1.options.speed_pendown = 10       # set pen-down speed to slow
nd1.update()                         # Process changes to options

# Move out of bounds, using, using "moveto/lineto" (absolute move) syntax:

print_position()
nd1.moveto(0,1)              # Absolute pen-up move, to (0 inch, 1 inch)
print_position()

nd1.lineto(1,1)              # Absolute pen-down move, to (1 inch, 1 inch)
print_position()

nd1.lineto(3,-1)              # Absolute pen-down move, to (3 inch, -1 inch)
print_position()
# Out of bounds here; note that turtle position is down, but pen is up.
# Note that actual pen position is where it left bounds, but turtle position has moved.

nd1.lineto(5,1)              # Absolute pen-down move, to (5 inch, 1 inch)
print_position()

nd1.penup()
nd1.moveto(0,0)              # Pen-up return home
print_position()

nd1.disconnect()             # Close serial port to NextDraw
