import copy
from importlib import import_module
from types import SimpleNamespace

def get_conf(conf_module):
    """
    input: conf_module, e.g. "nextdrawcore.nextdraw_conf"
    outputs a SimpleNamespace copy of the module.
    it must be a *copy* because otherwise changes made in one
    NextDraw/NextDrawControl/NextDrawMerge instance will be reflected across other instances.
    This comes up in tests and in multi-NextDraw setups.
    """
    params = import_module(conf_module) # Configuration file

    # remove dunder methods/keys, which are a) irrelevant and b) cause problems with deepcopy/pickling
    clean_params = { key: value for key, value in params.__dict__.items() if key[:2] != "__" }

    clean_params = SimpleNamespace(**copy.deepcopy(clean_params))
    return clean_params
