# Keycloak identity presentation

GenioOne keeps the OIDC authorization flow in Keycloak and owns only the login presentation. The `genio-one` login theme is mounted by Compose and rendered as a ConfigMap by the customer Helm chart.

Enterprise branding is tenant-scoped in the Management Console. Open Settings, edit Login page branding, then use the existing Draft → Validate → Preview → Review → Publish flow. The login page reads only the published public projection. The realm attributes below remain the bootstrap fallback used before a tenant has published its first branding revision:

| Attribute | Purpose | Constraint |
| --- | --- | --- |
| `genio.login.brandName` | Name shown in the login header and browser title | 256 characters |
| `genio.login.tagline` | Optional headline in the brand panel | 256 characters |
| `genio.login.logoUrl` | Logo URL or same-origin relative path | HTTPS, loopback HTTP, or relative path; 2048 characters |
| `genio.login.primaryColor` | Six-digit hexadecimal action color | `#RRGGBB` |
| `genio.login.pageColor` | Six-digit hexadecimal page color | `#RRGGBB` |
| `genio.login.customCss` | Trusted CSS overrides loaded after the default theme | 16 KiB |

For Helm deployments, set the matching values under `identity.loginBranding`. For local post-install runs, use the `GENIO_ONE_KEYCLOAK_LOGIN_*` variables in the environment. The post-install reconciler merges these managed attributes with unrelated realm attributes so an upgrade does not remove customer identity metadata. Use the Management Console for day-to-day tenant changes so the revision, reviewer, publication, projection, and rollback evidence stays together.

`logoUrl` is intentionally URL-based rather than a browser upload. In the Management Console, an enterprise can paste an approved HTTPS asset URL from its own asset host. Upload storage and tenant-by-tenant asset selection are separate identity-provider concerns and are not mixed into the OIDC authorization request.
