/**
 * How long a test polls for a condition before it fails. Polling stops as soon as the condition holds, so a
 * long cap costs nothing when things are fast; it only keeps a busy machine (the whole suite at node's default
 * concurrency, a build alongside) from failing tests whose code is merely slow. Was 20 s in each file.
 */
export const TEST_WAIT_MS = 120_000;
