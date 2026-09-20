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

| Run | Edge msg/s | p50 ms | p95 ms | Depth p95 | Depth max | Tasks | Final tasks | Windows |
|---|---|---|---|---|---|---|---|---|
| baseline | 1.4 | - | - | 0 | 0 | 1 to 1 | 1 | 828 |

| Run | Against targets |
|---|---|
| baseline | all targets met |
