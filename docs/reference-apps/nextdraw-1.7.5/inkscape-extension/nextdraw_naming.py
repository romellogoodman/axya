'''
Automatically generated launcher to launch nextdraw_naming.
This launcher is used for scripts that are built via pyinstaller (e.g. nextdraw_control.py, nextdraw_naming.py).
To regenerate, run python bin/generatewrappers.py
'''
from os import path
import subprocess
import sys

executable = path.dirname(path.abspath(__file__)) + "/build_deps/nextdraw_naming"
command = [executable] + sys.argv[1:]
proc = subprocess.run(command, capture_output=True, text=True)

# print error messages, if there are any
if proc.stderr != "":
    sys.stderr.write(proc.stderr)

# inkscape parses stdout for the result of an extension
sys.stdout.write(proc.stdout)
