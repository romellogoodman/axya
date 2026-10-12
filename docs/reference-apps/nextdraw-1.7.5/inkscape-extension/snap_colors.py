'''
Automatically generated dumb wrapper to call nextdrawcore.snap_colors as an inkscape extension.
This wrapper is used for scripts that aren't built via pyinstaller, e.g., nextdraw_naming.py.
To regenerate, run python bin/generatewrappers.py
'''
import logging
from types import SimpleNamespace

from lxml import etree

from plot_utils_import import from_dependency_import
snap_colors = from_dependency_import('nextdrawcore.snap_colors')
exit_status = from_dependency_import('ink_extensions_utils.exit_status')
message = from_dependency_import('ink_extensions_utils.message')

root_logger = logging.getLogger()
root_logger.setLevel(logging.ERROR)
root_logger.addHandler(message.UserMessageHandler()) # to stderr/inkscape "has received additional data" window
# consider adding a handler to send logs to extension-errors.log?

if __name__ == '__main__':
    conf = None
    e = None # effect
    try:
        conf_dict = dict()
        exec(open('notamodule.py', encoding='utf-8').read(), dict(), conf_dict)
        conf = SimpleNamespace(**conf_dict)
        e = snap_colors.ColorSnap(params=conf, default_logging=False)
    except (FileNotFoundError, ImportError) as err:
        if "notamodule" == "notamodule":
            # assuming everything is going well, this just means there is no config or logging assigned in the generatewrappers.py script
            e = snap_colors.ColorSnap()
        else:
            raise
    exit_status.run(e.affect)
