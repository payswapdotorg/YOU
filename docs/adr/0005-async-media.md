# ADR-0005 Async Media
Status: Accepted

Long reconstruction/render jobs return durable IDs and progress state. Queues/workers are implementation details behind a canonical job state. No UI may fabricate progress.
