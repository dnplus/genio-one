# Core concepts

> Draft placeholder: examples will be expanded as the product model is finalized.

## Authorization path

`Subject → Access Group → Access relationship → Access Package → Resource Capability → Entitlement`

| Concept | Purpose |
| --- | --- |
| Subject | A Person, Application, or product-owned verified Agent identity. |
| Access Group | A reusable authorization scope backed by organization or identity evidence. |
| Access Package | A curated set of Resource Capabilities. |
| Entitlement | The effective grant produced from the published policy relationship. |
| One Policy | The Tenant-owned authorization model and its published revisions. |

## Product API

Use **Product API reference** for the interactive OpenAPI contract. Product documentation explains workflows and concepts; the API reference remains authoritative for request and response shapes.

## Application authorization

SSO verifies the user's identity. OAuth scopes limit the operations an application may perform on their behalf. Third-party applications show the requested scopes at first authorization and ask again when requesting more access. Personal settings links to the identity provider's connected-application management page when available.

| Scope | Permitted operations |
| --- | --- |
| `genioone:read` | Read personal data and perform read-only operations on entitled Resources. |
| `genioone:write` | Update personal data, submit requests, and perform write operations on entitled Resources. |
| `genioone:invoke` | Invoke entitled models and agents. |
| `management:<domain>:<operation>` | Perform the specified operation within existing administration rights; policy publication, access approval, and audit export require separate scopes. |

Every operation still checks current roles, Organization scope, Entitlements, and One Policy. General read/write scopes do not grant administration rights, and an administrative role does not automatically grant Resource access. MCP read/write classification uses published Capabilities and reviewed tools rather than HTTP methods or unreviewed upstream hints.

An Organization Administrator can issue an API key from an Application's credentials panel, choosing Platform operations or one API/LLM Resource Capability, scopes, and an expiry. The key identifies the Application itself; its secret is shown once and it can be rotated or revoked. Platform keys cannot access Resource ingress, and Resource keys cannot access Platform APIs. MCP uses OAuth. Gateway credential changes become effective after the updated configuration is applied.
