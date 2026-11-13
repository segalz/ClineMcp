#!/bin/bash
set -u
cd "$(dirname "$0")"
lane() { # $1 bridge $2 parity
  for i in 01 02 03 04 05 06 07 08 09 10; do
    q="q$i"; n=$((10#$i + $2))
    if [ $((n % 2)) -eq 0 ]; then order="A0 A1"; else order="A1 A0"; fi
    for a in $order; do timeout 560 node pilot.mjs "$1" "$a" "$q" < /dev/null; done
  done
}
# two lanes per bridge: lane parity splits questions? keep simple: one lane per bridge per arm-order variant
lane cline 0 > log-cline.txt 2>&1 &
lane opencode 1 > log-opencode.txt 2>&1 &
wait
echo ALLDONE
