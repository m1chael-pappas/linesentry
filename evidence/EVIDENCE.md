# Evidence

Measured results, written by the experiment harness. Each run's raw samples, summary and plot are in `evidence/<variant>/<run>/`.

Targets come from the project brief. A missed target is reported as missed rather than adjusted.

| Target | Value |
|---|---|
| Edge output, steady | at most 80 msg/s |
| End to end p95 | under 5000 ms |
| Steady queue depth | under 100, draining within 60s of a burst ending |
| Detection tasks | scale from 1 upward and back |

## baseline

| Run | p50 ms | p95 ms | Agg depth max | Det depth max | Agg tasks | Det tasks | Windows |
|---|---|---|---|---|---|---|---|
| burst | 1875 | 2212 | 224 | 962 | 1 to 1 | 0 to 1 | 9855 |
| overload | 91740 | 155744 | 43866 | 45293 | 1 to 6 | 1 to 6 | 9525 |

| Run | Against targets |
|---|---|
| burst | MISSED: steady_queue_depth |
| overload | MISSED: p95_end_to_end, steady_queue_depth |
