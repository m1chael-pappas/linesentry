#!/usr/bin/env bash
# Runs one experiment scenario unattended and writes its results into
# evidence/<variant>/<run>/.
#
#   ./experiments/run.sh baseline
#   ./experiments/run.sh burst
#   VARIANT=dual-prediction-b1-hb600 BOUND=1 HEARTBEAT_S=600 ./experiments/run.sh burst
#
# VARIANT must match the variant the stack was deployed with, since it is both
# the metric dimension and the output directory. BOUND and HEARTBEAT_S are
# recorded in the summary and must match what the gateway was started with.
set -uo pipefail

cd "$(dirname "$0")/.."

RUN="${1:-}"
VARIANT="${VARIANT:-baseline}"
REGION="${AWS_REGION:-us-east-1}"
SEED="${SEED:-linesentry}"
BOUND="${BOUND:-}"
HEARTBEAT_S="${HEARTBEAT_S:-}"
EDGE_FILTER="${EDGE_FILTER:-$([[ -n $BOUND ]] && echo dual-prediction || echo deadband)}"

if [[ -z $RUN ]]; then
  echo "usage: run.sh <baseline|ramp|burst|overload|scale|scale-in|failure>" >&2
  exit 1
fi

OUT="evidence/$VARIANT/$RUN"
mkdir -p "$OUT"

SIM_PID=""
stop_simulator() {
  [[ -n $SIM_PID ]] && kill "$SIM_PID" 2>/dev/null
  SIM_PID=""
}
trap stop_simulator EXIT

start_simulator() {
  local machines=$1 lines=${2:-1}
  stop_simulator
  SEED="$SEED" FAULT_LOG="$OUT/faults.jsonl" \
    node simulator/dist/index.js "$machines" "$lines" < /dev/null \
    > "$OUT/simulator.log" 2>&1 &
  SIM_PID=$!
  echo "simulator started at $machines machines on $lines line(s), pid $SIM_PID"
}

fault() {
  node simulator/dist/control.js "$@"
}

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

case "$RUN" in
  baseline)
    start_simulator 20 1
    node experiments/sample.mjs "$OUT/samples.csv" 600 | tee "$OUT/sampling.log"
    ;;

  ramp)
    STEPS="${RAMP_STEPS:-20 60 100 140 180 200}"
    STEP_SECONDS="${RAMP_STEP_SECONDS:-300}"
    offset=0

    for machines in $STEPS; do
      start_simulator "$machines" 4
      node experiments/sample.mjs "$OUT/samples-$machines.csv" "$STEP_SECONDS" \
        | tee -a "$OUT/sampling.log"
    done

    head -1 "$OUT/samples-${STEPS%% *}.csv" | sed 's/$/,machines/' > "$OUT/samples.csv"
    for machines in $STEPS; do
      tail -n +2 "$OUT/samples-$machines.csv" |
        awk -F, -v off="$offset" -v m="$machines" 'BEGIN{OFS=","}{$1=$1+off; print $0, m}' \
        >> "$OUT/samples.csv"
      offset=$((offset + STEP_SECONDS))
    done
    ;;

  burst)
    start_simulator 50 4
    node experiments/sample.mjs "$OUT/samples-pre.csv" 120 | tee "$OUT/sampling.log"
    echo "faulting all of line-A"
    fault line-A overheat
    node experiments/sample.mjs "$OUT/samples.csv" 600 | tee -a "$OUT/sampling.log"
    ;;

  overload)
    RATE="${LOAD_RATE:-300}"
    SECONDS_OF_LOAD="${LOAD_SECONDS:-480}"
    export WINDOWS_TOPIC_ARN="${WINDOWS_TOPIC_ARN:-$(aws sns list-topics --region "$REGION" \
      --query "Topics[?contains(TopicArn,'linesentry-windows')].TopicArn|[0]" --output text)}"

    echo "driving $RATE windows/s for ${SECONDS_OF_LOAD}s directly at the ingest topic"
    node experiments/load.mjs "$RATE" "$SECONDS_OF_LOAD" > "$OUT/load.log" 2>&1 &
    LOAD_PID=$!
    node experiments/sample.mjs "$OUT/samples.csv" $((SECONDS_OF_LOAD + 420)) | tee "$OUT/sampling.log"
    kill $LOAD_PID 2>/dev/null
    ;;

  scale)
    MACHINES_AT_SCALE="${SCALE_MACHINES:-6000}"
    SECONDS_OF_LOAD="${LOAD_SECONDS:-600}"
    WARMUP="${WARMUP_SECONDS:-90}"
    export WINDOWS_TOPIC_ARN="${WINDOWS_TOPIC_ARN:-$(aws sns list-topics --region "$REGION" \
      --query "Topics[?contains(TopicArn,'linesentry-windows')].TopicArn|[0]" --output text)}"

    echo "plant load: $MACHINES_AT_SCALE machines through the $EDGE_FILTER filter for ${SECONDS_OF_LOAD}s"
    EDGE_FILTER="$EDGE_FILTER" ERROR_BOUND_SIGMA="${BOUND:-1}" \
      HEARTBEAT_MS=$(( ${HEARTBEAT_S:-60} * 1000 )) WARMUP_SECONDS="$WARMUP" \
      node experiments/load.mjs plant "$MACHINES_AT_SCALE" "$SECONDS_OF_LOAD" > "$OUT/load.log" 2>&1 &
    LOAD_PID=$!
    node experiments/sample.mjs "$OUT/samples.csv" $((WARMUP + SECONDS_OF_LOAD + 180)) | tee "$OUT/sampling.log"
    wait $LOAD_PID
    ;;

  scale-in)
    echo "clearing faults and waiting for the task count to settle"
    start_simulator 50 4
    fault line-A "" 2>/dev/null || true
    node experiments/sample.mjs "$OUT/samples.csv" 1200 | tee "$OUT/sampling.log"
    ;;

  failure)
    start_simulator 50 4
    node experiments/sample.mjs "$OUT/samples-pre.csv" 60 | tee "$OUT/sampling.log"
    fault line-A overheat
    (sleep 45 && aws ecs update-service --cluster linesentry --service linesentry-detection \
      --desired-count 1 --region "$REGION" >/dev/null && \
      TASK=$(aws ecs list-tasks --cluster linesentry --service-name linesentry-detection \
        --region "$REGION" --query 'taskArns[0]' --output text) && \
      aws ecs stop-task --cluster linesentry --task "$TASK" --region "$REGION" >/dev/null && \
      echo "stopped detection task $TASK") &
    node experiments/sample.mjs "$OUT/samples.csv" 600 | tee -a "$OUT/sampling.log"
    ;;

  *)
    echo "unknown run $RUN" >&2
    exit 1
    ;;
esac

stop_simulator
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "collecting metrics for $started_at to $finished_at"
BOUND="$BOUND" HEARTBEAT_S="$HEARTBEAT_S" \
  node experiments/collect.mjs "$OUT" "$started_at" "$finished_at" "$RUN" "$VARIANT"
python3 experiments/plot.py "$OUT" "$RUN" "$VARIANT"
node experiments/evidence.mjs "$VARIANT"

echo "run $RUN finished, results in $OUT"
