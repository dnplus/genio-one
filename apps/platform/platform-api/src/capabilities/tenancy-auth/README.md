# Management API trust boundary

The Management API authenticates tenant-scoped requests before capability
handlers run. `PrincipalAuthenticator` is the product seam. The production
adapter verifies OIDC JWTs against a preconfigured HTTPS issuer and remote
JWKS, including issuer, audience and an asymmetric-algorithm allowlist. The
request path selects the Tenant trust configuration before token verification;
unverified token claims never select a JWKS or Tenant.

Set `GENIO_ONE_MANAGEMENT_API_AUTH_MODE=oidc` and provide
`GENIO_ONE_MANAGEMENT_API_OIDC_TENANTS_JSON` as an array of Tenant issuer,
audience, JWKS, algorithm and claim-mapping objects. The IdP must map the
product roles `USER`, `ORGANIZATION_ADMINISTRATOR`, or
`TENANT_ADMINISTRATOR` into the configured role claim. Invalid configuration
stops startup. Signature or claim failures reject the request without exposing
verifier details.

The `static-dev` environment adapter is only an explicitly configured fixture.
With no explicit mode it fails closed, and `NODE_ENV=production` disables the
fixture unconditionally.

The request principal is the only source for `tenant_id`, `subject_id`, role,
organization membership, and `client_id`. Resource publication actor fields
are normalized from that context, and model routing obtains effective
entitlements from an injected resolver. A missing resolver rejects routing
rather than trusting `entitled_model_ids` from the request body.

The TypeScript Control Plane is the sole canonical writer. The Management API
has no Rust Product API read fallback or per-tenant writer switch; authorization
is determined only from the authenticated principal and capability ownership.
