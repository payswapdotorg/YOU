// Next.js instrumentation hook — runs ONCE per server boot, before any route.
// P6.A2: production config must be valid before the app serves a single
// request (fail-fast beats failing at the first upload/signature).
export async function register(): Promise<void> {
  const { assertProductionConfig } = await import('@/lib/you/core/config');
  assertProductionConfig();
}
