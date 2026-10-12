'''
low_level_usb.py

Demonstrate advanced features of nextdraw python module in "interactive" mode.


This demo file shows off the "usb_command" and "usb_query" features of
the interactive API. Interaction through these two commands essentially bypass
all software counters, speed, position, and limit checks that otherwise
ensure safe operations.

While these two "low-level USB" serial interface functions are very direct, they are also
powerful and potentially dangerous. They should be used with reluctance and caution,
since improper use is capable of causing damage of an unpredictable nature.

The serial protocol is documented at:
http://evil-mad.github.io/EggBot/ebb.html


This particular example file demonstrates:
* Moving the carriage away from the home position via moveto
* Querying and printing the firmware version via usb_query
* Querying and printing the step position via usb_query
* Returning to the home position via usb_command


Run this demo by calling: python low_level_usb.py


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

nd1.moveto(2,1)                  # Absolute pen-up move, to (2 inch, 1 inch)

version = nd1.usb_query("V") # Query firmware version
print("Firmware version data: " + version)

step_pos = nd1.usb_query("QS") # Query step position
print("Step pos: " + step_pos)

nd1.usb_command("HM,3200")    # Return home at a rate of 3200 steps per second

nd1.disconnect()             # Close serial port to NextDraw
