# Copyright 2025 Windell H. Oskay, Bantam Tools
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 2 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program; if not, write to the Free Software
# Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA

"""
versions.py

Part of the NextDraw driver software
http://bantamtools.com

"""

import sys
import ast
import logging

from nextdrawcore.plot_utils_import import from_dependency_import
requests = from_dependency_import('requests')
version = from_dependency_import('packaging.version')

logger = logging.getLogger('nextdrawcore.nextdraw.versions')

# keys used for reporting versions relevant to this repo
DEV_NEXTDRAW_CONTROL = "NextDraw Control (unstable)"
NEXTDRAW_CONTROL = "NextDraw Control"

# EBB firmware key
EBB_FIRMWARE = "EBB Firmware"

def get_versions_online(check_updates, message_fun, keys = None):
    '''
    this is easily used by any consumers of nextdraw-core

    keys is a list of software/firmware that we want versions for.
    If keys is None, default to [NEXTDRAW_CONTROL, DEV_NEXTDRAW_CONTROL, EBB_FIRMWARE]

    returns dict with the versions. list(dict.keys()) will equal the `keys` parameter, if provided.
    '''

    keys = (keys if keys is not None else
            ["NextDraw Control", "NextDraw Control (unstable)", "EBB Firmware"])
    online_versions = {}
    if check_updates:
        try:
            online_versions = _query_versions_url(keys)
        except RuntimeError as err_info:
            if err_info.__cause__:
                logger.debug("Version check detail: %s", err_info.__cause__)
            message_fun('\n' + str(err_info))
    else:
        message_fun('Note: Online version checking disabled.')

    return online_versions

def _query_versions_url(keys):
    ''' check online for current versions. does not require USB connection to plotter,
    but DOES require connection to the internet.

    returns dict with the versions.
    list(dict.keys()) will equal the `keys` parameter
    dict.values() will all be of type packaging.version.Version, or None

    raises RuntimeError if online check fails
    '''
    url = "https://bantam.tools/nd_version.txt"
    text = None
    try:
        text = requests.get(url, timeout=15).text
    except requests.exceptions.Timeout as err:
        raise RuntimeError(
            "Checking online for latest version timed out.") from err
    except (RuntimeError, requests.exceptions.ConnectionError) as err_info:
        raise RuntimeError(
            "Checking online for latest version did not succeed"
            " (unable to contact server).") from err_info

    if text:
        try:
            all_versions = ast.literal_eval(text)  # noqa: S307
            requested_versions = {
                key: version.parse(all_versions.get(key)) for key in keys
            }
            return requested_versions
        except (RuntimeError, ValueError, KeyError, SyntaxError) as err_info:
            raise RuntimeError(
                "Checking online for latest version did not succeed"
                " (no clear response from server)."
                ).with_traceback(sys.exc_info()[2])

    raise RuntimeError(
        "Checking online for latest version did not succeed"
        " (empty response from server).")

def _report_nextdraw_control_version(online_versions, current_version_string, message_fun):
    '''
    `online_versions` is a Versions namedtuple or False,
    e.g. the return value of get_versions_online
    '''
    report_software_version(
            NEXTDRAW_CONTROL,
            version.parse(current_version_string),
            online_versions.get(NEXTDRAW_CONTROL),
            online_versions.get(DEV_NEXTDRAW_CONTROL),
            message_fun,
            stable_updates_url = "bantam.tools/ndsoft"
    )

def report_software_version(
        software_name, local_version, stable_version, dev_version, message_fun,
        stable_updates_url=False):
    '''
    this is easily used by any consumers of nextdrawcore

    `local_version`, `stable_version`, `local_version` are all of type `packaging.version.Version`

    `stable_updates_url` a url where stable version updates can be found online

    `online_versions` is a dict containing relevant keys or False,
    e.g. the return value of get_versions_online
    '''
    update_contact_str = "To update, please contact NextDraw technical support."

    name_readable = software_name
    if software_name == "NextDraw Control":
        name_readable = "Bantam Tools NextDraw™"

    message_fun(f"This is {name_readable} version {local_version}.")

    if stable_version is None or dev_version is None: # no version data was retrieved from web
        return

    if stable_version > local_version:
        message_fun("An update is available to a newer version, " +
                f"{stable_version}.")
        if stable_updates_url: # NextDraw Control, probably
            message_fun(f"Please visit: {stable_updates_url} for the latest software.")
        else: # Other software
            message_fun(update_contact_str)
    elif local_version > stable_version:
        message_fun("(An early-release version)")
        if dev_version > local_version:
            message_fun(f"A newer early-release build is available: {dev_version}.")
            message_fun(update_contact_str)
        elif dev_version == local_version:
            message_fun("This is the newest available development version.")

        message_fun(f'(The current "stable" release is v. {stable_version}).')
    else:
        message_fun(f"Your {name_readable} software is up to date.")

def report_ebb_version(fw_version_string, online_versions, message_fun):
    '''
    this is easily used by any consumers of nextdrawcore

    `online_versions` is False if we failed or didn't try to get the online versions

    If `fw_version_string` is None or not a valid version, reports that the firmware
    version could not be read and skips the online comparison.
    '''
    try:
        fw_version = version.parse(fw_version_string)
    except (TypeError, version.InvalidVersion):
        message_fun("\nThe firmware version of your NextDraw could not be read.\n")
        return

    message_fun(f"\nYour NextDraw has firmware version {fw_version_string}.")

    if online_versions:
        if online_versions[EBB_FIRMWARE] > fw_version:
            message_fun(
                    f"Newer EBB firmware is available: v. {online_versions[EBB_FIRMWARE]};")
            message_fun("To download the updater, please visit: bantam.tools/ndfw\n")
        else:
            message_fun("Your firmware is up to date; no updates are available.\n")

def report_version_info(nd_ref, message_fun):
    '''
    currently should only be used by nextdrawcore, might change in the future todo decide

    works whether or not `check_updates` is True, online versions were successfully retrieved,
    or `plot_status.port` is None (i.e. not connected NextDraw)
    '''

    online_versions = get_versions_online(nd_ref.params.check_updates, message_fun)

    _report_nextdraw_control_version(online_versions, nd_ref.version_string, message_fun)

    voltage, current = None, None
    if nd_ref.machine.port is not None: # i.e. there is a connected NextDraw
        voltage, current = nd_ref.machine.query_current()
        report_ebb_version(nd_ref.machine.version, online_versions, message_fun)
    elif nd_ref.options.preview:
        message_fun("\nFirmware version checking not available in preview mode.")

    message_fun('\nAdditional system information:')
    message_fun(sys.version)
    if voltage is not None and current is not None:
        scaled_voltage = 0.3 + voltage * 3.3 * 9.2 / 1023 # Scaling depends on hardware version
        scaled_current = current  * 3.3 / (1023 * 1.76)
        message_fun(f'Voltage readout: {voltage:d} (~ {scaled_voltage:.2f} V).')
        message_fun(f'Current setpoint: {current:d} (~ {scaled_current:.2f} A).')

def min_fw_version(nd_ref, version_string):
    '''
    this is easily used by any consumers of nextdrawcore

    Using already-known firmware version string in plot_status:
    Return True if the EBB firmware version is at least version_string.
    Return False if the EBB firmware version is below version_string.
    Return None if we are unable to determine True or False.
    '''
    if nd_ref.machine.version_parsed is None:
        return None
    if nd_ref.machine.version_parsed >= version.parse(version_string):
        return True
    return False

def min_merge_version(ext_call, merge_version):
    '''
    Check to see if a NextDraw Merge version is defined. If it is,
    then assert what the minimum version required is.
    '''
    old_version = False
    old_version_string = ""

    if not ext_call:
        return None     # No external caller. No worries.
    if ext_call is True: # Boolean; Called by something out of date.
        old_version = True

    if isinstance(ext_call, str):
        if ext_call[0:15] == 'nextdraw merge,':
            old_version_string = ext_call[15:]
            if version.parse(old_version_string) < version.parse(merge_version):
                old_version = True

    if old_version:
        if old_version_string != "":
            old_version_string = ",\nand you currently have version NextDraw Merge " +\
                                f"version {old_version_string} installed."
        else:
            old_version_string = "."

        return_string = "Error: Your NextDraw Merge software needs to be updated.\n\n" +\
        f"The minimum required version of NextDraw Merge is {merge_version}" +\
        old_version_string

        return return_string
    return None
