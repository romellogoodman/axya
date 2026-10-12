'''
nextdraw.py   - Command line interface (CLI) for NextDraw.

For quick help:
    python nextdraw.py --help

Full user guide:  
    https://axidraw.com/doc/cli_api/


This script is a stand-alone version of NextDraw Control, accepting 
various options and providing a facility for setting default values.

'''

from nextdraw.nextdraw_cli import nextdraw_CLI

if __name__ == '__main__':
    nextdraw_CLI()
