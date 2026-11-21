#!/bin/bash
# OpenCode half of the hard set (finish-all F9, 2026-11-22), on the fixed bridges.
# Nvidia free model; at most 2 calls at once per provider (Nvidia returns 429 under parallel load).
# A0 = regex map, A1 = codeindex ranking v2. 3 reps, arm order alternated.
set -u
cd "$(dirname "$0")"
mkdir -p outH4
export QFILE=hardq.json OUTSUF=H4 OCMODEL=nvidia/nvidia/nemotron-3-ultra-550b-a55b
lane() { for i in 01 02 03 04 05 06 07 08 09 10; do
  n=$((10#$i + $1)); if [ $((n % 2)) -eq 0 ]; then order="A0 A1"; else order="A1 A0"; fi
  for a in $order; do REP=$1 timeout 560 node pilot.mjs opencode "$a" "h$i" < /dev/null; done; done; }
lane 1 > logH4-1.txt 2>&1 &
lane 2 > logH4-2.txt 2>&1 &
wait
lane 3 > logH4-3.txt 2>&1
echo ALLDONE
