import {
  CSRF_HEADER,
  CSRF_VALUE,
  SESSION_COOKIE,
  parseCookieHeader,
} from './session-cookies.ts'
import { PLATFORM_SESSION_COOKIES } from './auth-context.ts'
import type { AuthContext } from './auth-context.ts'

/**
 * CSRF policy.
 *
 * ## What CSRF actually is
 *
 * A cross-site request forgery works because the browser **attaches ambient
 * credentials by itself**: a cookie destined for this origin travels with a
 * request another site caused. The attacker never learns the cookie value; they
 * only need the victim's browser to send it.
 *
 * That gives the rule this module implements. A request is in the CSRF threat
 * class **only when its authentication can be carried by the browser
 * automatically** — a cookie. A caller that has to *construct* an
 * `Authorization` header is not: a third-party page cannot set that header on a
 * cross-origin request without a preflight this app never grants, and it cannot
 * read the credential to set it in the first place.
 *
 * ## The two lanes
 *
 * - **Ambient-credential lane (cookie).** The marker header is mandatory, as it
 *   always was. A request that carries a session cookie — of *either* flavor —
 *   never takes the exemption below, even if it also carries a bearer header.
 * - **Explicit-credential lane (bearer).** Exempt from the marker header, and
 *   only after `verifyCredential` has accepted the token.
 *
 * ## Why the exemption cannot be spoofed
 *
 * The exemption is keyed on **possession of a cryptographically verified token**,
 * not on a claim. A `Authorization: Bearer <anything>` does not qualify: the
 * credential is verified before the exemption is granted, and a failed
 * verification falls back to the marker requirement. An attacker who could mint
 * a valid token for the victim has already defeated authentication itself; the
 * same is true for an attacker who could set the victim's cookie. The exemption
 * moves the bar from "can cause a request" to "holds a credential", which is
 * exactly the bar that stops CSRF.
 *
 * The marker header is therefore **not authentication** and must never be
 * treated as such: it is a CSRF heuristic that a bearer client simply does not
 * need. Authorization remains the action route's job (`resolveCaller` + the
 * owner gate), and it runs regardless of this module's verdict.
 *
 * ## What is deliberately *not* exempt
 *
 * `/api/auth/*` (sign-in, sign-out, session issue) is never eligible: those
 * routes exist to *create* credentials, so "a valid credential was presented"
 * would be circular. They keep the marker header unconditionally.
 *
 * A marker-header **failure** is reported as an authorization refusal, never as
 * a 404 or 500, so a client can distinguish "my credential is fine but the CSRF
 * marker is missing" from "I am not allowed".
 */

/** Status code used when the marker header is absent on a cookie request. */
export const CSRF_MARKER_STATUS = 403

export interface CsrfDecision {
  /** The request may proceed. */
  allowed: boolean
  /**
   * Why, for logs and tests. Never sent to the client: the reason a CSRF check
   * failed is not information an attacker should be able to probe for.
   */
  reason:
    | 'safe-method'
    | 'marker-present'
    | 'verified-bearer'
    | 'marker-missing'
    | 'ineligible-path'
  /** True when the marker header was required and absent. */
  markerMissing: boolean
}

export interface CsrfPolicyInput {
  method: string
  /** Request headers; only `cookie`, `authorization` and the marker are read. */
  headers: Headers
  /** Path, used only to exclude credential-issuing routes from the exemption. */
  path: string
  /**
   * Verify an explicit credential (bearer token).
   *
   * Resolves to the identity when the token is valid, or `null` when it is not.
   * The policy treats `null` as "no exemption" — it never fails open.
   */
  verifyCredential: () => Promise<AuthContext | null>
  /**
   * Resolve identity from ambient credentials (session cookie).
   *
   * Accepted for symmetry with `verifyCredential` and used to attribute a
   * refused request in logs. It deliberately has **no** effect on the decision:
   * a cookie-backed request never takes the exemption, valid or not.
   */
  resolveAmbient?: () => Promise<AuthContext | null>
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Routes that issue credentials; the bearer exemption never applies to them. */
const CREDENTIAL_ROUTES = ['/api/auth/']

function hasMarker(headers: Headers): boolean {
  return headers.get(CSRF_HEADER) === CSRF_VALUE
}

/** A bearer credential is present at all (validity is checked separately). */
function hasBearer(headers: Headers): boolean {
  const header = headers.get('authorization')
  return Boolean(header && header.startsWith('Bearer ') && header.slice(7).trim())
}

/**
 * Is *any* session cookie present on this request?
 *
 * Presence alone decides the lane — not validity. An invalid cookie must not be
 * able to buy the bearer exemption, and a bearer client that also happens to
 * carry a stale cookie is still treated as a cookie request.
 */
export function hasSessionCookie(headers: Headers): boolean {
  const cookies = parseCookieHeader(headers.get('cookie'))
  if (cookies[SESSION_COOKIE]) return true
  return PLATFORM_SESSION_COOKIES.some((name) => Boolean(cookies[name]))
}

/**
 * Evaluate the CSRF policy for one request.
 *
 * Pure with respect to the request: it reads headers, may call the verifier, and
 * returns a decision. It performs no logging and sets no state.
 */
export async function evaluateCsrfPolicy(input: CsrfPolicyInput): Promise<CsrfDecision> {
  if (SAFE_METHODS.has(input.method.toUpperCase())) {
    return { allowed: true, reason: 'safe-method', markerMissing: false }
  }

  if (hasMarker(input.headers)) {
    return { allowed: true, reason: 'marker-present', markerMissing: false }
  }

  // Marker absent from here on. Only an explicit, verified credential may skip it.
  const eligible = !CREDENTIAL_ROUTES.some((prefix) => input.path.startsWith(prefix))
  if (!eligible) {
    return { allowed: false, reason: 'ineligible-path', markerMissing: true }
  }

  // A cookie-carrying request is in the CSRF threat class by definition.
  if (hasSessionCookie(input.headers)) {
    return { allowed: false, reason: 'marker-missing', markerMissing: true }
  }

  if (!hasBearer(input.headers)) {
    return { allowed: false, reason: 'marker-missing', markerMissing: true }
  }

  // Verify before exempting. A forged or expired token does not qualify, and a
  // verifier that throws is treated as a failed verification, not as a bypass.
  let verified: AuthContext | null = null
  try {
    verified = await input.verifyCredential()
  } catch {
    verified = null
  }
  if (!verified) {
    return { allowed: false, reason: 'marker-missing', markerMissing: true }
  }

  return { allowed: true, reason: 'verified-bearer', markerMissing: false }
}
