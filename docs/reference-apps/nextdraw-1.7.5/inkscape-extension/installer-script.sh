#!/bin/bash

printf "\n\nBantam Tools NextDraw™ v1.7.5 software installer."
printf "\n\nBeginning installation."

mkdir -p ~/Library/Application\ Support/org.inkscape.Inkscape/config/inkscape/extensions

cp -R ./payload/  ~/Library/Application\ Support/org.inkscape.Inkscape/config/inkscape/extensions/

printf "\nInstallation complete.\nVerifying...\n"

FILE=~/Library/Application\ Support/org.inkscape.Inkscape/config/inkscape/extensions/nextdraw.inx
if [ -f "$FILE" ]; then
    printf " \nInstallation successful.\n \nPlease restart Inkscape before using."
else 
    printf " \nInstallation may have failed.\n \nPlease try again and/or contact Bantam Tools technical support."
fi
