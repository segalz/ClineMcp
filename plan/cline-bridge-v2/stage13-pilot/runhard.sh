#!/bin/bash
set -u
cd "$(dirname "$0")"
export QFILE=hardq.json OUTSUF=H
lane() { # $1 bridge $2 rep list
  for rep in $2; do
    for i in 01 02 03 04 05 06 07 08 09 10; do
      n=$((10#$i + rep)); if [ $((n % 2)) -eq 0 ]; then order="A0 A1"; else order="A1 A0"; fi
      for a in $order; do REP=$rep timeout 560 node pilot.mjs "$1" "$a" "h$i" < /dev/null; done
    done
  done
}
lane cline "1 3" > logH-cline-a.txt 2>&1 &
lane cline "2" > logH-cline-b.txt 2>&1 &
lane opencode "1 3" > logH-opencode-a.txt 2>&1 &
lane opencode "2" > logH-opencode-b.txt 2>&1 &
wait
echo ALLDONE
