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
| baseline | 1244 | 1317 | 0 | 0 | 4 to 6 | 4 to 6 | 1160 |
| ramp | 2331 | 4504 | 292 | 226 | 1 to 1 | 1 to 1 | 43216 |
| burst | 2125 | 4806 | 10 | 50 | 1 to 2 | 1 to 2 | 9953 |
| overload | 91740 | 155744 | 43866 | 45293 | 1 to 6 | 1 to 6 | 9525 |

| Run | Against targets |
|---|---|
| baseline | all targets met |
| ramp | MISSED: steady_queue_depth |
| burst | all targets met |
| overload | MISSED: p95_end_to_end, steady_queue_depth |

## deadband-hb60

| Run | p50 ms | p95 ms | Agg depth max | Det depth max | Agg tasks | Det tasks | Windows |
|---|---|---|---|---|---|---|---|
| baseline | 1111 | 1306 | 0 | 0 | 1 to 1 | 3 to 6 | 1482 |
| burst | 1561 | 3587 | 231 | 3 | 1 to 1 | 6 to 6 | 10521 |
| scale | 83157 | 183151 | 71936 | 106675 | 1 to 6 | 1 to 6 | 252767 |

| Run | Against targets |
|---|---|
| baseline | all targets met |
| burst | all targets met |
| scale | MISSED: edge_output, p95_end_to_end, steady_queue_depth |

## dual-prediction-b0.5-hb600

| Run | p50 ms | p95 ms | Agg depth max | Det depth max | Agg tasks | Det tasks | Windows |
|---|---|---|---|---|---|---|---|
| baseline | 628 | 2142 | 0 | 46 | 1 to 1 | 1 to 1 | 588 |
| burst | 1288 | 2155 | 32 | 79 | 1 to 1 | 1 to 1 | 7722 |
| scale | 48769 | 109016 | 21352 | 38572 | 1 to 6 | 1 to 6 | 140098 |

| Run | Against targets |
|---|---|
| baseline | all targets met |
| burst | all targets met |
| scale | MISSED: edge_output, p95_end_to_end, steady_queue_depth |

## dual-prediction-b1-hb600

| Run | p50 ms | p95 ms | Agg depth max | Det depth max | Agg tasks | Det tasks | Windows |
|---|---|---|---|---|---|---|---|
| scale | 11582 | 59333 | 2689 | 15074 | 1 to 6 | 1 to 6 | 80611 |

| Run | Against targets |
|---|---|
| scale | MISSED: edge_output, p95_end_to_end, steady_queue_depth |

## dual-prediction-b2-hb600

| Run | p50 ms | p95 ms | Agg depth max | Det depth max | Agg tasks | Det tasks | Windows |
|---|---|---|---|---|---|---|---|
| baseline | 626 | 2040 | 0 | 0 | 1 to 1 | 1 to 1 | 182 |
| burst | 1277 | 1878 | 32 | 53 | 1 to 1 | 1 to 1 | 4618 |
| scale | 2679 | 9147 | 1375 | 5643 | 1 to 1 | 1 to 1 | 38885 |

| Run | Against targets |
|---|---|
| baseline | all targets met |
| burst | all targets met |
| scale | MISSED: p95_end_to_end, steady_queue_depth |

## deadband-hb60-pinned

| Run | p50 ms | p95 ms | Agg depth max | Det depth max | Agg tasks | Det tasks | Windows |
|---|---|---|---|---|---|---|---|
| scale-m1000 | 5694 | 6175 | 369 | 1291 | 1 to 1 | 1 to 1 | 17984 |
| scale-m2500 | 15814 | 66675 | 1802 | 19865 | 1 to 6 | 1 to 1 | 43688 |

| Run | Against targets |
|---|---|
| scale-m1000 | MISSED: p95_end_to_end, steady_queue_depth |
| scale-m2500 | MISSED: edge_output, p95_end_to_end, steady_queue_depth |

## dual-prediction-pinned

| Run | p50 ms | p95 ms | Agg depth max | Det depth max | Agg tasks | Det tasks | Windows |
|---|---|---|---|---|---|---|---|
| scale-b0.5-m2000 | 3639 | 4807 | 0 | 1139 | 5 to 6 | 1 to 1 | 20508 |
| scale-b0.5-m4000 | 6995 | 7099 | 624 | 4553 | 2 to 4 | 1 to 1 | 39567 |
| scale-b1-m3000 | 2988 | 57767 | 256 | 351 | 2 to 2 | 1 to 1 | 15503 |
| scale-b1-m7000 | 17568 | 37550 | 3720 | 2985 | 1 to 6 | 1 to 1 | 30797 |
| scale-b2-m18000 | 4592 | 57980 | 0 | 21028 | 6 to 6 | 1 to 1 | 46868 |
| scale-deadband-m2500 | 3969 | 7450 | 434 | 5843 | 3 to 6 | 1 to 1 | 44433 |

| Run | Against targets |
|---|---|
| scale-b0.5-m2000 | MISSED: steady_queue_depth |
| scale-b0.5-m4000 | MISSED: p95_end_to_end, steady_queue_depth |
| scale-b1-m3000 | MISSED: p95_end_to_end |
| scale-b1-m7000 | MISSED: p95_end_to_end, steady_queue_depth |
| scale-b2-m18000 | MISSED: edge_output, p95_end_to_end, steady_queue_depth |
| scale-deadband-m2500 | MISSED: edge_output, p95_end_to_end, steady_queue_depth |

## Plant scale on AWS

The seeded plant run through each arm's filter by `load.mjs plant` and published to the ingest topic. Every arm sees the same plant, so the message rate and the task count differ only by the filter.

| Variant | Machines | Published msg/s | Per machine msg/s | Detection tasks | Det depth max | p95 ms | Messages to detection | Windows judged | Windows rebuilt |
|---|---|---|---|---|---|---|---|---|---|
| deadband-hb60 | 6000 | 421.28 | 0.07021 | 1 to 6 | 106675 | 183151 | 252772 | 252772 | - |
| dual-prediction-b0.5-hb600 | 6000 | 233.5 | 0.03892 | 1 to 6 | 38572 | 109016 | 140098 | 779618 | 639520 |
| dual-prediction-b1-hb600 | 6000 | 134.13 | 0.02236 | 1 to 6 | 15074 | 59333 | 80479 | 543227 | 462748 |
| dual-prediction-b2-hb600 | 6000 | 64.77 | 0.0108 | 1 to 1 | 5643 | 9147 | 38863 | 269073 | 230210 |

Per-task capacity is the median messages per second one detection task processed in the minutes its queue never emptied. Machines per task divides the control arm's capacity by each arm's published rate per machine, so only the filter differs between rows.

| Variant | Per-task msg/s, saturated | Saturated minutes | Tasks needed at control capacity | Machines per task at control capacity | Detection task-minutes |
|---|---|---|---|---|---|
| deadband-hb60 | 100.8 | 11 | 4.18 | 1436 | 46 |
| dual-prediction-b0.5-hb600 | 114.7 | 7 | 2.32 | 2590 | 48 |
| dual-prediction-b1-hb600 | 91.7 | 4 | 1.33 | 4508 | 48 |
| dual-prediction-b2-hb600 | 85.2 | 1 | 0.64 | 9333 | 14 |

## Plant scale on one detection task

Plant-scale runs that held one detection task from start to finish. A run that kept up drains its queue within seconds of the load stopping; one that fell behind takes minutes, and its backlogged minutes measure one task's capacity at that arm's traffic. Machines per task divides that capacity by the run's published rate per machine. Each deployment runs its own task, so runs under one variant share a task and runs under different variants do not.

| Run | Bound sigma | Machines | Published msg/s | Det depth max | Depth when load stopped | Drained after s | One-task msg/s, backlogged | Backlogged minutes | CPU ms/msg, backlogged | Machines per task | Metadata reads/msg | Alert reads/msg |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dual-prediction-b2-hb600/scale | 2 | 6000 | 64.77 | 5643 | 3041 | 64 | 85.2 | 1 | 2.93 | 7889 | 0.677 | 0.947 |
| deadband-hb60-pinned/scale-m1000 | - | 1000 | 74.93 | 1291 | 965 | 12 | - | - | - | - | 0.222 | 0.612 |
| deadband-hb60-pinned/scale-m2500 | - | 2500 | 182.03 | 19865 | 16472 | - | 103.3 | 6 | 2.4 | 1419 | 0.312 | 0.818 |
| dual-prediction-pinned/scale-b0.5-m2000 | 0.5 | 2000 | 85.45 | 1139 | 0 | 1 | - | - | - | - | 0.326 | 0.868 |
| dual-prediction-pinned/scale-b0.5-m4000 | 0.5 | 4000 | 164.86 | 4553 | 3942 | 34 | 160.7 | 3 | 1.52 | 3899 | 0.343 | 0.869 |
| dual-prediction-pinned/scale-b1-m3000 | 1 | 3000 | 64.6 | 351 | 0 | 0 | - | - | - | - | 0.514 | 0.93 |
| dual-prediction-pinned/scale-b1-m7000 | 1 | 7000 | 128.32 | 2985 | 1320 | 30 | 135 | 3 | 1.91 | 7365 | 0.551 | 0.938 |
| dual-prediction-pinned/scale-b2-m18000 | 2 | 18000 | 195.28 | 21028 | 20277 | - | 118.8 | 5 | 2.08 | 10949 | 0.821 | 0.983 |
| dual-prediction-pinned/scale-deadband-m2500 | - | 2500 | 185.14 | 5843 | 3389 | 40 | 169.8 | 3 | 1.43 | 2293 | 0.234 | 0.717 |

## Offline sweep across seeds

The faults sweep repeated on 5 seeds (`linesentry`, `seed-2`, `seed-3`, `seed-4`, `seed-5`), each a different plant with the same fault schedule. Each cell is the mean with the range across seeds.

| Arm | msg/s | Consumer coverage % | Worst error sigma | Faults | Events on healthy machines | Fewer messages than deadband/hb60 |
|---|---|---|---|---|---|---|
| deadband/hb60 | 15.29 (15.26 to 15.36) | 19.2 (19.2 to 19.3) | - | 16/16 | 56 (50 to 61) | 1.00 (1.00 to 1.00)x |
| deadband/hb600 | 5.99 (5.92 to 6.11) | 7.6 (7.5 to 7.8) | - | 16/16 | 40 (32 to 47) | 2.55 (2.51 to 2.58)x |
| dual-prediction/0.5sigma/hb600 | 8.72 (8.65 to 8.78) | 100.0 (100.0 to 100.0) | 0.50 (0.50 to 0.50) | 16/16 | 43 (39 to 49) | 1.75 (1.74 to 1.77)x |
| dual-prediction/1sigma/hb600 | 5.39 (5.35 to 5.43) | 100.0 (100.0 to 100.0) | 1.00 (1.00 to 1.00) | 16/16 | 91 (81 to 107) | 2.84 (2.82 to 2.86)x |
| dual-prediction/2sigma/hb600 | 3.38 (3.37 to 3.40) | 100.0 (100.0 to 100.0) | 2.00 (2.00 to 2.00) | 16/16 | 206 (193 to 211) | 4.52 (4.51 to 4.54)x |

## Offline sweep, faults

200 machines over 1800s, seed `linesentry`, 16 faults injected, 144000 windows produced.
Every arm judges the same windows, fanned out from one aggregator and one smoother. Machines per task is derived from 100.8 messages/s/task, measured on AWS.
The full grid is in `evidence/sweep/faults/sweep.csv`, plotted in `sweep-faults.png`.

| Arm | msg/s | Fewer messages | Consumer coverage | Faults | FP | Machines per task | More machines |
|---|---|---|---|---|---|---|---|
| deadband/hb60 | 15.26 | 1.00x | 19.2% | 16/16 | 50 | 1321 | 1.00x |
| dual-prediction/0.5sigma/hb600 | 8.78 | 1.74x | 100% | 16/16 | 43 | 2297 | 1.74x |
| dual-prediction/1sigma/hb600 | 5.4 | 2.83x | 100% | 16/16 | 81 | 3732 | 2.83x |
| dual-prediction/2sigma/hb600 | 3.38 | 4.51x | 100% | 16/16 | 193 | 5957 | 4.51x |

| Arm | msg/s | Dropped % | Coverage % | Evaluated/s | Worst error sigma | Faults | Delay p95 | FP | Machines per task |
|---|---|---|---|---|---|---|---|---|---|
| deadband/hb60 | 15.26 | 80.9 | 19.2 | 15.26 | - | 16/16 | 3 | 50 | 1321 |
| deadband/hb150 | 8.24 | 89.7 | 10.4 | 8.24 | - | 16/16 | 3 | 34 | 2448 |
| deadband/hb300 | 6.66 | 91.7 | 8.4 | 6.66 | - | 16/16 | 3 | 37 | 3028 |
| deadband/hb600 | 5.95 | 92.6 | 7.6 | 5.95 | - | 16/16 | 3 | 37 | 3389 |
| dual-prediction/0.25sigma/hb60 | 22.38 | 72 | 100 | 79.01 | 0.25 | 16/16 | 3 | 77 | 901 |
| dual-prediction/0.5sigma/hb60 | 16.02 | 80 | 100 | 78.88 | 0.5 | 16/16 | 3 | 86 | 1259 |
| dual-prediction/0.75sigma/hb60 | 14.64 | 81.7 | 100 | 78.79 | 0.75 | 16/16 | 3 | 90 | 1377 |
| dual-prediction/1sigma/hb60 | 14.18 | 82.3 | 100 | 78.39 | 1 | 16/16 | 3 | 94 | 1422 |
| dual-prediction/1.5sigma/hb60 | 14.03 | 82.5 | 100 | 78.28 | 1.5 | 16/16 | 3 | 95 | 1437 |
| dual-prediction/2sigma/hb60 | 13.99 | 82.5 | 100 | 78.24 | 2 | 16/16 | 3 | 94 | 1441 |
| dual-prediction/3sigma/hb60 | 13.96 | 82.6 | 100 | 78.22 | 2.9978 | 16/16 | 4 | 94 | 1445 |
| dual-prediction/4sigma/hb60 | 13.94 | 82.6 | 100 | 78.24 | 3.9268 | 16/16 | 3 | 94 | 1446 |
| dual-prediction/0.25sigma/hb150 | 18.32 | 77.1 | 100 | 65.01 | 0.25 | 16/16 | 3 | 48 | 1100 |
| dual-prediction/0.5sigma/hb150 | 10.2 | 87.2 | 100 | 52.43 | 0.5 | 16/16 | 3 | 60 | 1976 |
| dual-prediction/0.75sigma/hb150 | 8.19 | 89.8 | 100 | 46.39 | 0.75 | 16/16 | 3 | 67 | 2461 |
| dual-prediction/1sigma/hb150 | 7.64 | 90.5 | 100 | 45.25 | 1 | 16/16 | 3 | 94 | 2640 |
| dual-prediction/1.5sigma/hb150 | 6.69 | 91.6 | 100 | 39.77 | 1.5 | 16/16 | 3 | 142 | 3012 |
| dual-prediction/2sigma/hb150 | 6.49 | 91.9 | 100 | 38.5 | 2 | 16/16 | 3 | 169 | 3109 |
| dual-prediction/3sigma/hb150 | 6.16 | 92.3 | 100 | 36.47 | 3 | 16/16 | 4 | 170 | 3275 |
| dual-prediction/4sigma/hb150 | 6.01 | 92.5 | 100 | 35.56 | 4 | 16/16 | 4 | 168 | 3354 |
| dual-prediction/0.25sigma/hb300 | 17.74 | 77.8 | 100 | 61.86 | 0.25 | 16/16 | 3 | 47 | 1136 |
| dual-prediction/0.5sigma/hb300 | 9.13 | 88.6 | 100 | 45.45 | 0.5 | 16/16 | 3 | 49 | 2208 |
| dual-prediction/0.75sigma/hb300 | 6.6 | 91.8 | 100 | 36.1 | 0.75 | 16/16 | 3 | 63 | 3057 |
| dual-prediction/1sigma/hb300 | 6.01 | 92.5 | 100 | 34.12 | 1 | 16/16 | 3 | 94 | 3354 |
| dual-prediction/1.5sigma/hb300 | 4.58 | 94.3 | 100 | 25 | 1.5 | 16/16 | 3 | 155 | 4399 |
| dual-prediction/2sigma/hb300 | 4.21 | 94.7 | 100 | 22.58 | 2 | 16/16 | 2 | 200 | 4789 |
| dual-prediction/3sigma/hb300 | 4 | 95 | 100 | 21.36 | 3 | 16/16 | 3 | 214 | 5045 |
| dual-prediction/4sigma/hb300 | 3.91 | 95.1 | 100 | 20.83 | 4 | 16/16 | 3 | 201 | 5163 |
| dual-prediction/0.25sigma/hb600 | 17.58 | 78 | 100 | 60.85 | 0.25 | 16/16 | 3 | 47 | 1147 |
| dual-prediction/0.5sigma/hb600 | 8.78 | 89 | 100 | 43.1 | 0.5 | 16/16 | 3 | 43 | 2297 |
| dual-prediction/0.75sigma/hb600 | 6.06 | 92.4 | 100 | 32.45 | 0.75 | 16/16 | 3 | 67 | 3327 |
| dual-prediction/1sigma/hb600 | 5.4 | 93.2 | 100 | 29.87 | 1 | 16/16 | 3 | 81 | 3732 |
| dual-prediction/1.5sigma/hb600 | 3.88 | 95.2 | 100 | 20.06 | 1.5 | 16/16 | 3 | 164 | 5201 |
| dual-prediction/2sigma/hb600 | 3.38 | 95.8 | 100 | 16.81 | 2 | 16/16 | 2 | 193 | 5957 |
| dual-prediction/3sigma/hb600 | 3.01 | 96.2 | 100 | 14.48 | 3 | 16/16 | 3 | 182 | 6694 |
| dual-prediction/4sigma/hb600 | 2.82 | 96.5 | 100 | 13.28 | 4 | 16/16 | 3 | 173 | 7138 |

## Offline sweep, steady

200 machines over 1800s, seed `linesentry`, 0 faults injected, 144000 windows produced.
Every arm judges the same windows, fanned out from one aggregator and one smoother. Machines per task is derived from 100.8 messages/s/task, measured on AWS.
The full grid is in `evidence/sweep/steady/sweep.csv`, plotted in `sweep-steady.png`.

| Arm | msg/s | Fewer messages | Consumer coverage | Faults | FP | Machines per task | More machines |
|---|---|---|---|---|---|---|---|
| deadband/hb60 | 15.06 | 1.00x | 18.9% | 0/0 | 51 | 1339 | 1.00x |
| dual-prediction/0.5sigma/hb600 | 8.43 | 1.79x | 100% | 0/0 | 45 | 2391 | 1.79x |
| dual-prediction/1sigma/hb600 | 5.09 | 2.96x | 100% | 0/0 | 85 | 3961 | 2.96x |
| dual-prediction/2sigma/hb600 | 3.1 | 4.86x | 100% | 0/0 | 199 | 6495 | 4.85x |

| Arm | msg/s | Dropped % | Coverage % | Evaluated/s | Worst error sigma | Faults | Delay p95 | FP | Machines per task |
|---|---|---|---|---|---|---|---|---|---|
| deadband/hb60 | 15.06 | 81.2 | 18.9 | 15.06 | - | 0/0 | - | 51 | 1339 |
| deadband/hb150 | 7.97 | 90 | 10 | 7.97 | - | 0/0 | - | 34 | 2529 |
| deadband/hb300 | 6.4 | 92 | 8.1 | 6.4 | - | 0/0 | - | 37 | 3150 |
| deadband/hb600 | 5.69 | 92.9 | 7.2 | 5.69 | - | 0/0 | - | 37 | 3545 |
| dual-prediction/0.25sigma/hb60 | 22.08 | 72.4 | 100 | 79.02 | 0.25 | 0/0 | - | 79 | 913 |
| dual-prediction/0.5sigma/hb60 | 15.73 | 80.3 | 100 | 78.89 | 0.5 | 0/0 | - | 89 | 1282 |
| dual-prediction/0.75sigma/hb60 | 14.36 | 82 | 100 | 78.77 | 0.75 | 0/0 | - | 93 | 1404 |
| dual-prediction/1sigma/hb60 | 13.91 | 82.6 | 100 | 78.37 | 1 | 0/0 | - | 98 | 1449 |
| dual-prediction/1.5sigma/hb60 | 13.8 | 82.8 | 100 | 78.27 | 1.5 | 0/0 | - | 100 | 1461 |
| dual-prediction/2sigma/hb60 | 13.78 | 82.8 | 100 | 78.23 | 2 | 0/0 | - | 100 | 1463 |
| dual-prediction/3sigma/hb60 | 13.78 | 82.8 | 100 | 78.22 | 2.9375 | 0/0 | - | 100 | 1463 |
| dual-prediction/4sigma/hb60 | 13.78 | 82.8 | 100 | 78.22 | 3.625 | 0/0 | - | 100 | 1463 |
| dual-prediction/0.25sigma/hb150 | 18 | 77.5 | 100 | 64.91 | 0.25 | 0/0 | - | 49 | 1120 |
| dual-prediction/0.5sigma/hb150 | 9.88 | 87.7 | 100 | 52.23 | 0.5 | 0/0 | - | 61 | 2041 |
| dual-prediction/0.75sigma/hb150 | 7.88 | 90.2 | 100 | 46.14 | 0.75 | 0/0 | - | 68 | 2559 |
| dual-prediction/1sigma/hb150 | 7.34 | 90.8 | 100 | 45 | 1 | 0/0 | - | 98 | 2747 |
| dual-prediction/1.5sigma/hb150 | 6.42 | 92 | 100 | 39.49 | 1.5 | 0/0 | - | 145 | 3140 |
| dual-prediction/2sigma/hb150 | 6.23 | 92.2 | 100 | 38.25 | 2 | 0/0 | - | 169 | 3235 |
| dual-prediction/3sigma/hb150 | 5.94 | 92.6 | 100 | 36.23 | 3 | 0/0 | - | 168 | 3395 |
| dual-prediction/4sigma/hb150 | 5.81 | 92.7 | 100 | 35.31 | 4 | 0/0 | - | 166 | 3472 |
| dual-prediction/0.25sigma/hb300 | 17.41 | 78.2 | 100 | 61.68 | 0.25 | 0/0 | - | 48 | 1158 |
| dual-prediction/0.5sigma/hb300 | 8.8 | 89 | 100 | 45.24 | 0.5 | 0/0 | - | 53 | 2291 |
| dual-prediction/0.75sigma/hb300 | 6.26 | 92.2 | 100 | 35.73 | 0.75 | 0/0 | - | 63 | 3219 |
| dual-prediction/1sigma/hb300 | 5.71 | 92.9 | 100 | 33.84 | 1 | 0/0 | - | 97 | 3530 |
| dual-prediction/1.5sigma/hb300 | 4.3 | 94.6 | 100 | 24.63 | 1.5 | 0/0 | - | 159 | 4691 |
| dual-prediction/2sigma/hb300 | 3.94 | 95.1 | 100 | 22.18 | 2 | 0/0 | - | 197 | 5123 |
| dual-prediction/3sigma/hb300 | 3.77 | 95.3 | 100 | 21.02 | 3 | 0/0 | - | 214 | 5354 |
| dual-prediction/4sigma/hb300 | 3.69 | 95.4 | 100 | 20.52 | 4 | 0/0 | - | 198 | 5459 |
| dual-prediction/0.25sigma/hb600 | 17.24 | 78.5 | 100 | 60.65 | 0.25 | 0/0 | - | 48 | 1170 |
| dual-prediction/0.5sigma/hb600 | 8.43 | 89.5 | 100 | 42.79 | 0.5 | 0/0 | - | 45 | 2391 |
| dual-prediction/0.75sigma/hb600 | 5.72 | 92.9 | 100 | 32.02 | 0.75 | 0/0 | - | 69 | 3528 |
| dual-prediction/1sigma/hb600 | 5.09 | 93.6 | 100 | 29.5 | 1 | 0/0 | - | 85 | 3961 |
| dual-prediction/1.5sigma/hb600 | 3.59 | 95.5 | 100 | 19.67 | 1.5 | 0/0 | - | 170 | 5618 |
| dual-prediction/2sigma/hb600 | 3.1 | 96.1 | 100 | 16.36 | 2 | 0/0 | - | 199 | 6495 |
| dual-prediction/3sigma/hb600 | 2.77 | 96.5 | 100 | 14.07 | 3 | 0/0 | - | 185 | 7269 |
| dual-prediction/4sigma/hb600 | 2.61 | 96.7 | 100 | 12.91 | 4 | 0/0 | - | 174 | 7734 |
