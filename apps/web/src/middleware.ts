// Middleware — request-id correlation for the API surface (P6.A7).
//
// Every /api/v1/* request gets an x-request-id (honoring an inbound value
// from trusted proxies so distributed traces stitch): generated with the
// Web Crypto API (edge runtime), echoed on the response, and visible to
// route handlers via the request header for audit correlation.
// Matcher excludes the health probe (no overhead on LB checks) — hmm, no:
// the probe GETS an id too (one uuid, negligible) so operators can
// correlate every request they ever made. Kept uniform deliberately.
import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest): NextResponse {
  const inbound = request.headers.get('x-request-id');
  // accept inbound ids (proxies/load balancers stitch traces); constrain the
  // charset + length so the echoed value can never smuggle header garbage
  const requestId =
    inbound && /^[A-Za-z0-9._-]{8,64}$/.test(inbound)
      ? inbound
      : crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('x-request-id', requestId);
  return res;
}

export const config = {
  matcher: '/api/v1/:path*',
};
