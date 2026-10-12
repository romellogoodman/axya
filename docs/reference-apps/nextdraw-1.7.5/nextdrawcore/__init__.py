# Bail out if python is less than 3.10
import sys
MIN_VERSION = (3, 10)
if sys.version_info < MIN_VERSION:
    sys.exit("NextDraw software must be run with python 3.10 or greater.")
