# Strategy seams

Two steps in the pipeline are swappable at startup: the filter that decides which windows leave the edge gateway, and the algorithm that decides whether a window is a fault.
Everything else is fixed.

## Why they are swappable

This repo runs an A/B between the pipeline as built and a variant derived from published work on scalable IoT architectures, on identical load.
Both arms have to produce comparable evidence from the same experiment harness, which means both have to run in the same services, over the same queues, against the same message contract.
The only thing that differs between arms is which strategy the config selects.

The two variants planned are a dual prediction scheme replacing the edge deadband, and FFT feature extraction on the vibration signal replacing the raw window statistics.
Neither is implemented here.

## Adding a variant

A new strategy is a new file plus one `register` call.
It does not touch the service, the queue plumbing or the message handling.

```ts
import { detectionRegistry, type DetectionStrategy } from '@linesentry/core';

const spectral: DetectionStrategy = {
  name: 'spectral',
  evaluate(window, context) { ... },
};

detectionRegistry.register('spectral', () => spectral);
```

The service reads a strategy name from config at startup and calls `create`.
An unknown name fails at startup with the registered names in the message, rather than silently falling back to the baseline and quietly invalidating a run.

## Constraints a variant has to honour

**Detection strategies are pure.**
`evaluate` takes a window and a context and returns findings.
It does not write to a store, publish anything or hold state between calls.

The detection service owns event identity, deduplication and persistence.
An event id is a hash of `machine_id + sensor_type + window_start`, written with a conditional put that only succeeds when the id is absent, because SQS standard delivers at least once and several detection tasks run concurrently.
Keeping that in the service rather than the strategy means every arm of the experiment gets the same idempotency guarantee without reimplementing it.

It also means a strategy cannot tell whether the window it was handed arrived for the first time, arrived again after a visibility timeout, or was reconstructed by a mirrored predictor on the consumer side.
The dual prediction variant depends on that last case working, so nothing in a strategy may assume a window was actually transmitted.

**Extra fields go in `ext`.**
`ForwardedWindow.ext` is an open bag a variant fills and the matching consumer reads.
The baseline never sets it and never reads it, so a variant can add spectral peaks or prediction residuals without changing the baseline consumer or the stored row shape.

Adding a top-level field to `ForwardedWindow` instead would make the two arms' messages structurally different, which is exactly what the A/B is supposed to hold constant.

**Edge filters hold their own state.**
Unlike detection, an edge filter is stateful by nature: the deadband compares against the last value it sent, and a dual prediction scheme carries a predictor.
The factory builds one instance per gateway and that instance keeps its state.

A filter that a consumer has to mirror must be able to rebuild its state from the windows that were actually sent, since the consumer never sees the ones that were dropped.
