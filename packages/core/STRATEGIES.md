# Strategy seams

Two steps in the pipeline are selected at startup: the filter that decides which windows leave the edge gateway, and the algorithm that decides whether a window is a fault. Everything else is fixed.

## Purpose

This repo runs an A/B comparison between the pipeline as built and a variant derived from published work on scalable IoT architectures, using identical load.

Both arms produce comparable evidence from the same experiment harness. Both run in the same services, over the same queues, against the same message contract. Only the selected strategy differs.

The two planned variants are a dual prediction scheme replacing the edge deadband, and FFT feature extraction on the vibration signal replacing the raw window statistics. Neither is implemented here.

## Adding a variant

A new strategy is a new file plus one `register` call. It does not change the service, the queue plumbing or the message handling.

```ts
import { detectionRegistry, type DetectionStrategy } from '@linesentry/core';

const spectral: DetectionStrategy = {
  name: 'spectral',
  evaluate(window, context) { ... },
};

detectionRegistry.register('spectral', () => spectral);
```

The service reads a strategy name from config at startup and calls `create`. An unknown name fails at startup and lists the registered names. It does not fall back to the baseline, because a silent fallback would invalidate a run without saying so.

## Requirements on a variant

Detection strategies are pure. `evaluate` takes a window and a context and returns findings. It does not write to a store, publish anything, or hold state between calls.

The detection service owns event identity, deduplication and persistence. Event ids are a hash of `machine_id + sensor_type + window_start`, written with a conditional put that succeeds only when the id is absent. SQS standard delivers at least once and several detection tasks run concurrently.

Keeping that in the service means every arm gets the same idempotency guarantee without reimplementing it. It also means a strategy cannot tell whether a window arrived for the first time, arrived again after a visibility timeout, or was reconstructed by a mirrored predictor. The dual prediction variant depends on the reconstructed case working, so no strategy may assume a window was transmitted.

Extra fields go in `ext`. `ForwardedWindow.ext` is an open map a variant fills and the matching consumer reads. The baseline never sets or reads it, so a variant can add spectral peaks or prediction residuals without changing the baseline consumer or the stored row shape.

Adding a top-level field to `ForwardedWindow` would make the two arms' messages structurally different, which is what the A/B holds constant.

Edge filters hold their own state. A deadband compares against the last value it sent and a dual prediction scheme carries a predictor. The factory builds one instance per gateway and that instance keeps its state.

A filter that a consumer mirrors must rebuild its state from the windows that were sent, because the consumer never sees the ones that were dropped.
