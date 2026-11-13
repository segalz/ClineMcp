#!/bin/bash
# Ranking v2: Cline, arm A1 only, 3 reps (A0 reused from the first hard run).
set -u
cd "$(dirname "$0")"
export QFILE=hardq.json OUTSUF=H2
lane() { for i in 01 02 03 04 05 06 07 08 09 10; do REP=$1 timeout 560 node pilot.mjs cline A1 "h$i" < /dev/null; done; }
lane 1 > logH2-1.txt 2>&1 &
lane 2 > logH2-2.txt 2>&1 &
lane 3 > logH2-3.txt 2>&1 &
wait
echo ALLDONE
