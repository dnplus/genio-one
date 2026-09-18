# GenioOne

GenioOne is an enterprise AI enablement and governance platform. Its V1 value
is to discover and govern existing AI usage through one deterministic policy
language, without requiring customers to adopt a first-party chat Agent.

## Language

**One Policy**:
The shared decision semantics used across people, devices, applications,
third-party Agents, APIs, MCP, AI services, and enforcement points. It combines
visibility, access, route, obligations, accounting, and audit without making
one infrastructure product the source of truth.
_Avoid_: Gateway rule, Endpoint rule, Agent prompt

**Runtime Capability**:
An ability supplied by an Agent Runtime, such as shell execution, filesystem
access, extension loading or remote hands. It is a One Policy target distinct
from an enterprise Resource. Discovering an ability does not grant it.
_Avoid_: temporary Resource, prompt permission, provider credential

**Runtime Enforcement Point**:
The boundary that filters capability exposure and checks authority immediately
before an Agent Runtime performs an action. It applies the effective One Policy
decision and reports the observed result for the verified Subject and Acting
Client. An unsupported mandatory constraint results in denial.
_Avoid_: frontend checkbox, instruction-only restriction, separate policy authority

**Installed Service**:
A service supplied by an installation, represented through a stable Resource
and its Resource-owned Connection. Installation owns its presence; an
Administrator owns its permitted configuration and enablement. Reinstalling
does not erase configuration or undo a deliberate disablement.
_Avoid_: temporary test connector, automatically entitled service, separate Installation catalog

**Personal Codex Connection**:
A Person's connection to their own Codex subscription for an allowed Bot model
route. It requires its own One Policy permission and does not determine whether
the Person may use an entitled company model or Genio Bot itself.
_Avoid_: Bot service enablement, company model Entitlement, shared provider key

**First-party Capability Policy**:
A Platform-owned One Policy decision for a capability bundled with GenioOne. It
may provide a default grant for a verified Subject and Acting Client, but it
does not authenticate the Subject or mint a provider credential.
_Avoid_: environment flag, OIDC scope, provider subscription

**First-party Policy Seed**:
A tenant-scoped First-party Capability Policy instance whose origin is the
bundled system seed. It is listed and administered with every other Policy;
seed describes provenance and installation behaviour, not a separate policy
type or navigation area. Installation creates it enabled by default, and a
Tenant Administrator may disable or re-enable it without silently replacing
its definition.
_Avoid_: separate seed policy type, environment default, transient feature flag, OIDC scope

**Bot Model Route**:
The product-selected execution lane for a Bot model request. A Codex
subscription route uses the authenticated user's Codex subscription; it is not
an LLM Resource, Public Model or Platform-owned provider Connection.
_Avoid_: model catalog environment default, API provider profile, Entitlement

**Installation**:
The internal deployment, trust and physical persistence boundary for one
GenioOne installation. Existing `tenant_id` wire and storage fields are its
partition alias; Installation is not a customer-facing aggregate and does not
drive the ordinary product UI.
_Avoid_: customer Organization, Workspace, Tenant product aggregate

**Platform Administrator**:
The installation-wide Administrator who can manage and view every Organization,
policy, Resource and operational data set. This role does not make the Person
the Requester, Approver or granted Subject by default.
_Avoid_: Superuser, platform operator, every IT employee

**User**:
A verified Person without an administrative scope. A User sees their own
activity and the Resources and Capabilities granted to them; Organization or
Tenant-wide data is not implied.
_Avoid_: Member role with management authority, default administrator

**Organization Administrator**:
A verified Person who manages membership, Resources and operational data for
one Organization. Metrics, Traces, Logs and Dashboards are filtered to that
Organization. The same Person may be an Organization Administrator in one
Organization and a User in another. This role is assigned independently; it
is not derived from Tenant Administrator or Resource management permissions.
_Avoid_: Tenant Administrator, Registrar, Publisher, global role

**GenioOne Control Plane**:
The product authority for Tenant configuration, Catalog, policy definitions
and versions, access lifecycle, Desired State distribution and audit
correlation. It exposes those capabilities through the GenioOne Product API;
it does not replace an Enforcement Point or an external identity authority.
_Avoid_: Gateway admin, identity provider, Agent runtime

**GenioOne Product API**:
The versioned, product-owned command, query and event contracts used by the
Platform UI, Self-service, Endpoint Runtime, Gateway Runtime, provider adapters
and approved third-party integrations. An API operation authenticates its
caller before constructing domain evidence; request JSON cannot declare itself
verified.
_Avoid_: UI-only backend, raw database access, provider management API

**Identity Provider**:
The external authority for authentication, federation, OAuth/OIDC clients,
tokens, sessions and API scopes. Keycloak is the default planned V1
implementation, while canonical Subject mapping and every One Policy decision
remain in GenioOne.
_Avoid_: One Policy evaluator, Entitlement store, Keycloak role as grant

**Subject**:
The canonical identity evaluated by policy, such as a Person, Application, or
Agent. External identities map through the provider-neutral `issuer + subject`
pair. For Entra-backed people, `tid + oid` is the provider-specific stable key
used to derive that mapping; email is display and search metadata.
_Avoid_: Email user, Keycloak role

**Organization**:
The customer-visible ownership and governance boundary for people, Resources,
Use Cases and registered Applications. Users may participate in multiple
Organizations. Only an Organization Administrator or Platform Administrator
may manage an Organization. Organization membership may be verified as One
Policy input but never creates an Entitlement by itself.
_Avoid_: Team, Local Access Group, Keycloak group, Entitlement

**Application Registration**:
The durable binding between one Control Plane-generated Application ID, its
canonical Application Subject, its Owner Organization and the verified Person who
registered it. Callers cannot choose the Application ID or submit their own
permission evidence.
_Avoid_: OAuth client, API key, arbitrary Subject creation

**Application API Credential**:
A provider-backed inbound API key generation issued only to a registered
Application whose Capability Entitlement is active. GenioOne stores lifecycle,
provider reference, generation and grace metadata but returns the secret value
only once. Rotation creates a successor generation, bounds the predecessor's
overlap, and revoke invalidates the selected key without revoking the
Application Entitlement.
_Avoid_: provider credential, Credential Lease, Entitlement, reusable secret response

**Local Access Group**:
A Tenant-owned set of canonical Subjects used as explicit One Policy input.
V1 membership can be assigned manually or by `subject_id` CSV with durable
provenance; a future directory adapter may reconcile the same product model.
It is not an Identity Provider role and membership alone never creates an
Entitlement.
_Avoid_: Keycloak group, directory group as policy authority, entitlement group

**Access Package**:
A versioned, Tenant-owned selection of published Resource Capabilities used to
author understandable One Policy relationships and access requests. A package
may span Resources, but it is a reusable definition rather than an Entitlement
and never grants access by itself. Updating a package creates a successor
version; it does not silently widen existing Entitlements.
_Avoid_: role, Entitlement, Capability discovery, policy decision

**Requester**:
The Subject asking GenioOne to create an Access Request for a Target Subject.
The Requester may be the Target Subject, while an Acting Client only carries
out the request on their behalf.
_Avoid_: Acting Client, Approver, automatic target

**Target Subject**:
The Subject for whom an Access Request seeks an Entitlement. A self-service
request has the same Subject as both Requester and Target Subject. A verified
Person may instead target a registered Application only when they belong to
that Application's Owner Organization; every other cross-Subject request fails closed.
_Avoid_: Requester, Acting Client, beneficiary email

**Acting Client**:
The client or third-party Agent performing an operation for a Requester. Its
evidence level is explicit—verified, asserted, or unknown—and it never replaces
the Requester's Subject identity or grants itself authority. A Gateway activity
can identify the client used for one invocation, but classifying that client as
an Agent product requires registered metadata or verified Endpoint evidence.
_Avoid_: Requester, Approver

**Management Agent Client**:
A third-party OAuth/OIDC client acting with a verified administrator's delegated
identity against the same GenioOne Product API used by Platform UI. The bundled
Keycloak reference client uses Authorization Code plus S256 PKCE, carries an
explicit Acting Client ID, and receives no separate domain authority or bypass
around Product API authorization, validation, or Audit.
_Avoid_: GenioOne Agent runtime, service-account administrator, alternate management API

**Agent Workflow Reference**:
An opaque reference supplied by an identified third-party Acting Client when
an Access Request pauses its own workflow. GenioOne durably binds the reference
to that Requester, Acting Client and Access Request, then projects the approved
Request and currently active successor Entitlement back only to the same
identity. GenioOne does not execute, schedule or own the external Agent task.
_Avoid_: GenioOne Agent Run, browser-local task state, unscoped correlation ID

**Device**:
A registered Endpoint identity with posture, version, health, and applied
policy state that can participate in a decision.
_Avoid_: User, Endpoint process

**Endpoint Enrollment**:
The act of binding one stable Device identity to one verified Subject inside a
Tenant and returning that Tenant's Endpoint configuration.
_Avoid_: Login, device discovery, implicit registration

**Device Evidence**:
Transport-verified evidence that an Endpoint request is acting as a registered
Device. A Device ID sent by the client is not verified evidence by itself.
_Avoid_: Device ID, Subject evidence, self-asserted authentication

**Resource**:
A governed object that a Subject can discover, request, access or invoke,
including an MCP Server, API Product, AI Service, HTTP destination or private
application. A Resource may be a Gateway-facing Frontend, an observed
destination or another governed target; its position in a traffic path does
not define its identity.
_Avoid_: URL, Connection, Backend, gateway route

**Frontend Resource**:
A Resource published as an addressable Gateway entry point with a bounded
Capability surface. Every Frontend is a Resource, while a Resource does not
need to be a Frontend.
_Avoid_: Exposure, UI frontend, gateway route

**Resource Publication**:
The versioned audience, address and Capability publication settings owned by a
Frontend Resource. An Organization Administrator requests publication; the
Resource remains Draft until a Tenant Administrator approves that request. A
Tenant Administrator may publish directly. The approval request is separate
from the Resource lifecycle and does not make the Resource discoverable. Its
address binds a logical Gateway, hostname and base path. A custom hostname must
pass DNS ownership and routing verification before publication. This inbound
address is independent from every Connection's upstream endpoint.
_Avoid_: Exposure, Resource copy, Backend

**Resource Lifecycle**:
The Catalog lifecycle `Draft → Published → Deprecated → Retired`. Draft is
absent from general Catalog discovery and access requests, while verified
members of its Resource Owner Organization may access it for testing and validation.
Published replaces that Draft-only audience with One Policy visibility and
runtime projection; Deprecated remains published and usable while signaling
that consumers must migrate before retirement; Retired is terminal and removed
from new discovery without deleting audit or Entitlement history. Every
reverse-proxy Frontend Capability must have an available Resource-owned
Connection before publication; MCP additionally requires a verified Gateway
Runtime `initialize` + `tools/list` metadata snapshot. A forward-proxy
Destination Resource is not a Frontend and uses its governed destination
matcher instead of an upstream Connection.
_Avoid_: Backend enabled/disabled, provider health, policy version

**Authentication Strategy**:
The Resource-owned declaration of how GenioOne obtains provider authorization:
`NONE`, `EMA`, `OAUTH`, `API_KEY`, or `MTLS`. It is metadata, not a credential;
only a secret-store reference may be persisted on the Connection.
_Avoid_: bearer token, API key value, Entitlement

**Unclassified Resource**:
The inventory identity created when a verified Endpoint reports an AI or HTTP
destination that has no current routing Resource. It supports discovery and
usage aggregation; it is not a published Catalog Resource and does not imply
`BLOCK`.
_Avoid_: Unknown URL, denied Resource, published Resource

**Discovery Event**:
The first durable Endpoint observation that establishes an Unclassified
Resource for a Tenant. It records metadata and evidence, not request or response
content, and does not grant access or choose a route.
_Avoid_: Usage aggregate, Audit Event, Policy Decision

**Usage Event**:
A durable observation of AI or outbound HTTP activity associated with a Device, Subject,
Resource, route and explicit client evidence. An unverified process claim is
represented as `Unknown`.
_Avoid_: Audit Event, billing ledger, inferred process identity

**Invocation Accounting Record**:
An append-only, idempotent fact for one authorized Gateway invocation. The
Gateway supplies measured request/tool-call/byte quantities and may include
provider-reported token counts; the Control Plane derives Tenant, Subject,
Acting Client, Resource, Capability, route, Entitlement, Connection and
provider from canonical authorization and Catalog state. It never contains a
prompt, response body, credential value or estimated token/cost amount.
_Avoid_: Usage Event, Audit Event, Valkey counter, inferred bill

**Resource Usage Analytics**:
A time-bounded read model derived from Invocation Accounting Records and their
correlated Audit Events. It reports request volume, error rate, latency,
provider-reported tokens and top verified Subject/Acting Client consumers for
one Resource. Monetary cost is shown only when the governed Connection carries
explicit model pricing; priced and unpriced invocation coverage remains
visible and is never silently estimated.
_Avoid_: Provider billing ledger, raw telemetry dump, inferred price

**AI Usage Dashboard**:
A Tenant-wide, time-bounded read model that combines Endpoint observations and
Gateway Invocation Accounting without double-counting matching correlations.
It reports active Subjects, observed AI Resources, DIRECT/MANAGED/BLOCK request
distribution, measured usage and explicit pricing coverage. It is not a second
telemetry store and never estimates tokens or monetary cost.
_Avoid_: recent-record client aggregation, provider billing dashboard, ClickHouse as authority

**Use Case**:
An Organization-owned managed-directory entry selected by a caller and
verified by the Gateway before it becomes trusted Decision Context. It provides
a stable business-purpose dimension and an administrator-assigned risk level
for policy, routing, usage and cost attribution. The risk level is read from
the signed directory projection and never from a caller assertion.
_Avoid_: free-form request label, prompt classification, accounting key

**Trusted Decision Context**:
The bounded, attributable facts One Policy may use for one decision, with each
fact carrying a trusted source and observation revision. Caller assertions may
request context selection but never become authority without verification.
_Avoid_: request headers, prompt claims, cached allow

**Data Context**:
The trusted classifications observed for one request together with their
source, source version, trust level and applied handling action. A Data Context
may require a mandatory handling obligation but cannot grant a Capability or
expand an Entitlement. Caller-authored labels are not Data Context.
_Avoid_: prompt tag, raw payload, unversioned detector result, authorization grant

**Usage Policy Revision**:
An immutable policy revision whose selectors may include Subject, consumer
Organization, Resource, Capability and Use Case. Every matching policy applies
its common hard limits. A Platform Administrator or scoped Organization
Administrator may manage it, and activation requires the same signed Gateway
Release as authorization and routing policy.
_Avoid_: Connection usage control, Entitlement, generic CapacityGroup

**Accounting Key**:
An opaque identity assigned by a hard Usage Policy to the capacity being
accounted. Multiple Connections may share one key; counters are never derived
from Connection identity.
_Avoid_: Connection ID, credential value, provider quota as canonical truth

**Usage Admission Decision**:
A decision made after authorization and before upstream contact. It admits or
rejects with a typed quota, concurrency, credit, cost, unpriced or store-
unavailable reason while retaining the independent Entitlement decision.
_Avoid_: authorization denial, provider error, inferred Entitlement state

**Canonical Charge**:
The append-only charge identity shared by all retries and enforcement layers
for one invocation correlation and accounting key. Usage quantities and
estimated or actual valuations append provenance without creating a duplicate
charge or overwriting earlier evidence.
_Avoid_: Valkey counter, provider invoice, retry attempt charge

**Capability**:
A separately governable operation of a Resource, such as an MCP Tool, API
operation, OAuth scope, or model.
_Avoid_: Resource, role

**Resource Approver**:
A verified Person assigned to decide Access Requests for a Resource Owner
Organization. The default is an Organization Administrator of that
Organization; a policy may name another verified Approver or an ordered
approval workflow. This responsibility does not transfer ownership of the
Resource.
_Avoid_: Resource Owner Organization, Tenant Administrator by default, Requester

**Entitlement**:
A durable, attributable grant to a Subject for a bounded set of Resource
Capabilities, conditions, provenance, validity window, and lifecycle state.
_Avoid_: Connection, runtime allow, Keycloak role

**Access Request**:
The durable request to create an Entitlement. It distinguishes the Requester,
Acting Client, Target Subject, Resource, Capability, justification, Approver,
ordered Approval Stages, delegation provenance, and decision. `approver` is the
currently assigned Human Approver, not a parallel source of authority.
_Avoid_: Invocation, Agent confirmation

**Approval**:
A Human Approver's decision on the current stage of a pending Access Request.
The Resource Approver is the default stage; One Policy may require an ordered
Organization then Security workflow. Intermediate approval advances the request
and never creates an Entitlement. Final approval creates one only after current
policy, authority, and Resource state validate.
_Avoid_: Policy Decision, Entitlement, Agent consent

**Approval Delegation**:
A canonical, time-bounded assignment from a Primary Approver to a Delegate.
The Primary or a Tenant Administrator creates it. Access Requests snapshot the
Primary, assigned Delegate and delegation ID when entering the workflow so
later expiry cannot rewrite approval provenance.
_Avoid_: Agent delegation, permanent role assignment

**Agent Delegation**:
A revocable, time-bounded grant from a verified Person, Application or Agent
Subject to one Agent Subject. It bounds target Agents and Capabilities and
carries provenance plus a monotonic revocation generation. It never replaces
the target Agent's Entitlement or current One Policy decision.
_Avoid_: Approval Delegation, role assignment, caller-authored acting chain

**Agent Authority Mode**:
The signed admission fact that distinguishes an Agent using its own Entitlement
(`SELF`) from an Agent acting through an explicit bounded Delegation
(`DELEGATED`). Subject kind comes from the canonical Identity Directory and is
frozen into the Gateway Release; neither mode may be selected by a caller
header or inferred from an A2A task payload.
_Avoid_: client assertion, Acting Client, implicit Person Delegation, union of grants

**Agent Acting Chain**:
The ordered, immutable identity and Agent Delegation evidence frozen for one
admitted A2A invocation. GenioOne reconstructs every hop from canonical state;
the signed Decision Receipt stores the full chain and its revisions.
_Avoid_: request-body identity, Agent transcript, unverified requester claim

**Execution Grant**:
A one-time, expiring confirmation for one already-entitled high-risk action and
its immutable action digest. It authorizes neither another Capability nor a
future invocation.
_Avoid_: Entitlement, Access Approval, Delegation, reusable consent

**Blast Radius Snapshot**:
A read-only, as-of projection rooted at one canonical Subject and reconstructed
from Entitlement, Capability, Resource and active Agent Delegation state. The
default view contains only currently reachable paths; an explicit history view
may include expired or revoked paths as non-reachable evidence.
_Avoid_: authorization graph, cached Entitlement, generic identity graph

**Entitlement Risk Assessment**:
Versioned, explainable metadata that ranks Subject access using bounded factors
such as active grant count, capability sensitivity, TTL, inactivity and toxic
combinations. It never grants, denies or revokes access.
_Avoid_: One Policy decision, opaque AI score, automatic remediation

**Entitlement Access Review**:
A durable review that freezes a bounded set of active Entitlements, assigns a
verified reviewer to every item and records explicit retain or revoke
recommendations. Only a verified Tenant Administrator may complete the review
and apply recommended revocations; the immutable report retains review and
revoke provenance.
_Avoid_: Access Request approval, Policy evaluation, implicit bulk revoke

**Elicitation Session**:
A durable, correlation-bound pause for governed Agent input or approval. It
stores safe schema and lifecycle metadata, expires explicitly, and repeats
identity, delegation, Entitlement, Capability and Policy checks on resume.
_Avoid_: open transport stream, raw tool payload store, Access Request

**Agent Task**:
A durable lifecycle for long-running Agent work with created, running and
terminal evidence. Status and evidence replay never require the original
connection, and replay never contacts the selected upstream.
_Avoid_: immediate tool call, background process authority, payload archive

**Capability Extension Revision**:
A versioned EMA, Tasks or other protocol extension governed separately from
core MCP Tools. Discovery reports drift; only Preview, Validate and Publish may
change its visible Capability surface.
_Avoid_: automatically discovered Tool, Connection observation, implicit access

**Agent Extension Package**:
A versioned, Tenant-owned Skill or Plugin that may be installed into an Agent
Runtime. Its source may be an uploaded archive or an external source repository,
but an installable revision is immutable, validated and published explicitly.
The source location itself grants neither installation nor execution authority.
_Avoid_: live branch, arbitrary file, Connection, implicit runtime installation

**Resource Owner Organization**:
The Organization accountable for a Resource throughout its registration, publication
and retirement lifecycle. Verified members form the fixed testing audience
while the Resource is Draft. Individual members still require explicit
Organization Administrator or Tenant Administrator authority to edit or
publish it; creating a Resource does not make its
creator the permanent owner.
_Avoid_: creator, owner Subject, Tenant Administrator

**Organization Role**:
The Organization-scoped distinction between User and Organization
Administrator. Organization Administrators may register, edit and retire
Resources within their Organization, and request their publication. A Tenant
Administrator reviews those publication requests. The role also limits operational
data queries to the Organization. Registrar and Publisher are not separate
Person roles.
_Avoid_: Registrar, Publisher, Entitlement, Approval Delegation, Agent Delegation

**Emergency Access**:
An exceptional, self-scoped Entitlement allowed explicitly by active One
Policy for a Capability. A Tenant Administrator must present issuer-verified
MFA evidence and a reason; the policy caps validity at one hour or less. It has
distinct audit and grant provenance and expires through the normal Entitlement
lifecycle.
_Avoid_: ordinary approval bypass, caller-reported MFA, indefinite admin grant

**Connection**:
A Resource-owned concrete upstream configuration containing provider,
endpoint, protocol, an exact Provider Credential Profile binding, region,
health and routing policy.
A routable Frontend Resource has one or more Connections; Connection is the
product term for the concrete backend rather than a binding to another Backend
aggregate. A Connection belongs to exactly one Resource and cannot be rebound
or shared across Resources; provider alternatives and failover are represented
as multiple Connections owned by the same Resource.
_Avoid_: Backend aggregate, Exposure binding, Entitlement, permanent trust

**Connection Trust Certificate**:
The Connection-owned upstream TLS trust material used to verify a private or
self-signed endpoint. It may use the system CA store or an imported public
X.509 certificate chain; the certificate is public trust configuration, while
private keys and provider credentials remain outside the Connection. Its
fingerprint and validity window are observable evidence, and changing it is a
staged Connection revision that affects traffic only after a successor
Gateway Release is acknowledged.
_Avoid_: provider credential, client certificate, private key, inbound mTLS CA

**Downstream Identity Projection**:
The Connection-owned declaration of which identity mode an upstream Resource
receives after inbound authentication and One Policy authorization succeed.
Managed provider authentication is represented by the generic
`PROVIDER_CREDENTIAL_PROFILE` mode and an exact Provider Credential Profile
revision binding; provider exchange settings remain owned by that immutable
profile. User passthrough contains an explicit per-Connection forwarding
allowlist.
GenioOne compiles that intent to the Gateway's native upstream-authentication
and header-forwarding mechanisms. One Policy decides access but does not
translate, refresh or inject upstream credentials.
_Avoid_: provider-specific credential schema, One Policy obligation, caller-controlled header forwarding, credential value, global passthrough

**API Upstream Request Mapping**:
The API Connection-owned declaration of how an admitted request is presented
to its upstream. Unspecified headers and query parameters pass through after
untrusted internal and transport headers are removed; explicit rules may set
or remove individual values. Managed credentials are excluded and remain part
of Downstream Identity Projection. Publication freezes the mapping applied by
the Gateway for that Resource version.
_Avoid_: API Provider, credential injection rule, public route, arbitrary code transform, implicit secret

**MCP Tool Selection**:
The Connection-owned governed allowlist of MCP tools approved for publication.
It references one successful discovery observation for the same Connection and
is distinct from that observation: discovery reports what the upstream offers,
while selection records what the Resource owner chooses to expose. Publication
freezes the selection and compiles it into the Gateway's native per-backend
tool filter. An MCP Resource without an explicit non-empty selection cannot be
published.
_Avoid_: discovery result as Resource state, implicit expose-all, caller-supplied tool name, unversioned selection

**Connection Candidate Set**:
The immutable set of eligible Connections frozen by one admitted invocation's
routing revision. Runtime selection and failover stay inside that set, and the
receipt identifies the selected and attempted Connections.
_Avoid_: live Connection list, unbounded retry, mutable pool

**LLM Connection Profile**:
The canonical upstream protocol profile, optional known Provider identity,
supported data regions, public-to-upstream model mappings and enforceable
obligation kinds owned by one LLM Connection. An OpenAI-compatible endpoint may
use the generic profile without claiming to be OpenAI. Known Provider presets
only prefill a protocol profile, endpoint and credential strategy; they do not
create another Connection authority. The profile contains no credential value
and grants no access by itself.
_Avoid_: Frontend model surface, Policy rule, provider credential, live health

**Public Model**:
The stable model identifier published by an LLM Resource. One Policy and an
Entitlement constrain which Public Models a Subject may invoke; each eligible
Connection maps that identifier to its provider-specific upstream model. A
caller never selects a provider credential or bypasses the published alias by
naming an upstream model directly.
_Avoid_: provider model ID, Connection, Capability, credential

**Routing Requirement Set**:
The immutable public model IDs, region constraints and mandatory-obligation
kinds published with an LLM Frontend Resource revision. Model remains Policy input
alongside Capability rather than becoming a Capability itself. One Policy
still decides access and supplies the winning rule's obligations; routing
requirements narrow compatible Connections and never select a Provider directly.
_Avoid_: Policy baseline, Connection profile, credential, runtime preference

**Context Route Requirement**:
An immutable Resource-owner rule scoped to a consumer Organization, managed Use
Case and minimum risk level. It adds mandatory obligation kinds to an already
admitted invocation, filters only the signed Connection Candidate Set and
recomputes the invocation candidate digest. It never widens Entitlement,
changes Capability identity or selects a Provider directly.
_Avoid_: caller risk header, Usage Policy, provider preset, dynamic Connection discovery

**Routing Decision Receipt**:
The immutable evidence of one admitted request's public model, effective
upstream mapping, routing and policy revisions, required region/obligations,
candidate-set digest, selected Connection and ordered Connection attempts. It is
safe metadata for replay and audit, not authorization for a new request.
_Avoid_: mutable route, secret, cached entitlement, upstream response

**Model Route Lease**:
The session-scoped binding between an admitted AI session, its selected Public
Model, Connection and routing revision. It preserves prompt and provider cache
affinity across turns. Policy or health may force an explicit Route Transition;
after a successful failover the successor Connection remains sticky until the
lease expires or another transition is recorded.
_Avoid_: permanent route, Entitlement, provider session authority, hidden failover

**MCP Metadata Snapshot**:
The bounded, protocol-native `initialize` and `tools/list` observation reported
by a verified Genio Gateway Runtime for one MCP Connection. While the Resource
is Draft, it atomically replaces placeholder Capabilities with discovered Tool
Capabilities. Published Resource versions are immutable and reject resync.
_Avoid_: user-supplied tool list, invocation response, provider credential

**OpenAPI Metadata Snapshot**:
The normalized catalog projection imported from one validated OpenAPI 3.0 or
3.1 JSON document. Every unique `operationId` becomes one API Capability with
its method and path; the full source document is not canonical state. The
result starts as a Draft API Resource and still requires a matching Connection
and explicit Owner publication.
_Avoid_: Gravitee configuration, raw document archive, Connection, Entitlement

**Credential Lease**:
A revocable, expiring runtime-use envelope for one Connection and one
credential generation. It contains reference, generation and validity metadata
rather than the secret value, and it never grants Entitlement or invocation
access.
_Avoid_: Connection, provider secret, access token, Entitlement

**Provider Credential Profile Revision**:
An immutable Organization-owned outbound credential configuration selected by
an exact Connection binding. It separates the credential source from the
provider exchange adapter, contains only public configuration and opaque secret
references, and may be shared by multiple Connections without sharing their
endpoint, routing, health or Credential Lease. Provider presets may create or
prefill a profile, but the preset is not credential authority. Revocation makes
the latest profile revision terminal and invalidates future runtime use.
_Avoid_: Federation Trust Revision, Connection, provider endpoint, plaintext secret, Entitlement

**Federation Trust Revision**:
An immutable trust relationship that maps a bounded external workload
assertion to one canonical Application Subject. It proves authentication only
and cannot create or enlarge Entitlement.
_Avoid_: Provider Credential Profile Revision, external role, directory membership, authorization policy

**Quota Lease**:
A signed, expiring allocation of finite execution capacity for one Tenant,
Resource, Capability, dimension and window to one named runtime shard. It is
consumed only after a valid Policy Decision and never grants access.
_Avoid_: Entitlement, Policy Decision, global counter, rate-limit rule

**Evaluation Purpose**:
The intent of one policy evaluation: `DISCOVER`, `REQUEST`, or `INVOKE`. A
decision for one purpose never authorizes a different purpose.
_Avoid_: API endpoint, UI screen, cached allow

**Policy Decision**:
One immutable, versioned result for a Subject, Resource, Capability and
Evaluation Purpose, containing visibility, access, route, obligations, winning
policy and reason. Prompt output cannot establish it.
_Avoid_: Agent recommendation, gateway status

**Enforcement Chain**:
The ordered, versioned plan compiled from one effective One Policy decision and
the selected Resource publication. At admission it binds that Resource and its
eligible Connections to the applicable Enforcement Points. Its stable execution
primitives are Authenticate, Authorize, Process, Route and Observe; DLP,
tokenization, semantic classification and Audit are extensible actions attached
to their valid hooks rather than closed step kinds. Typed steps declare their
request, routing or response hooks, dependencies and supported Enforcement
Point. The compiler rejects missing, cyclic or unsupported ordering instead of
silently rearranging steps. Native Gateway capabilities are projected directly,
while only unsupported behavior is projected to a bounded external
authorization or processing adapter. Envoy CRDs are compiler output, not One
Policy types.
_Avoid_: fixed DLP form, CRD type as policy type, arbitrary script list, Gateway as policy authority

**Visibility Decision**:
`VISIBLE` or `HIDDEN`, controlling discovery and request metadata independently
from invocation access. It does not grant or revoke an Entitlement.
_Avoid_: Access Decision, Route Decision

**Access Decision**:
`ENTITLED`, `AUTO_GRANT`, `REQUEST`, or `DENY`, evaluated independently from
visibility and route. It is not an Access Request or Entitlement lifecycle state.
_Avoid_: Approval status, Entitlement state, allow boolean

**Route Decision**:
`DIRECT`, `MANAGED`, or `BLOCK`, applied at an explicit Enforcement Point.
`MANAGED` says that an invocation requires a managed enforcement path; it does
not require an overlay network or name the selected gateway/provider.
_Avoid_: Access Decision, Visibility Decision

**Managed Route Binding**:
The versioned deployment projection that resolves a `MANAGED` Route Decision
to an installed enforcement capability and provider. It can bind AI/MCP, API,
or private-resource traffic without adding provider names to One Policy.
_Avoid_: Route Decision, WireGuard route, provider policy

**Enforcement Provider**:
The Genio-owned module or approved external integration selected by a Managed
Route Binding to perform enforcement. A provider implements a decision and
reports observed state; it never becomes the canonical policy authority.
_Avoid_: One Policy, AI model provider, hard-coded gateway enum

**Bundled Product Substrate**:
An implementation delivered, administered and lifecycle-managed inside one
GenioOne release boundary. It may contain attributed OSS processes or
containers, but it requires no separate vendor account, control plane, product
license purchase or customer-facing administration workflow.
_Avoid_: embedded source code, mandatory installation, external provider estate

**External Provider Integration**:
An optional adapter to a separately acquired or operated customer/vendor estate.
It can satisfy a provider-neutral binding through supported interfaces, but it
is never the only implementation of a V1 capability.
_Avoid_: Bundled Product Substrate, required V1 dependency, direct provider database access

**Obligation**:
A typed condition that a named Enforcement Point must satisfy before forwarding
an authorized invocation. It becomes an ordered Enforcement Chain step or a
native Gateway configuration and cannot grant access or override `BLOCK`.
_Avoid_: Recommendation, prompt instruction, best effort

**Primary Enforcement Point**:
The gateway or runtime point that owns invocation-path enforcement for a
Resource capability. Endpoint policy may add local enforcement for the same
Resource, but does not replace this primary point.
_Avoid_: exclusive enforcement location, all enforcement points

**GenioOne Endpoint**:
The Tier 2 local enforcement point for device posture, AI and HTTP destination discovery,
selective routing, local allow/block, policy sync, event reporting, and
optional enforcement adapters. It can operate without a private-access tunnel.
_Avoid_: GenioOne Agent, full VPN, EDR

**GenioOne Secure Access**:
The optional managed-access module included in the Tier 2 commercial
entitlement and composed of an Endpoint adapter, a
customer-side access gateway, and encrypted transport fabric. When selected as
the delivery for a Managed Route Binding, its gateway dispatches traffic to the
bound AI/MCP, API, or private-resource target. GenioOne Endpoint and those
target capabilities do not depend on it being installed. Its V1 implementation
is a Bundled Product Substrate; existing Firezone or ZTNA estates are External
Provider Integrations rather than that bundled implementation.
_Avoid_: GenioOne Endpoint, One Policy, mandatory VPN

**Secure Access Transport**:
The encrypted endpoint-to-access-gateway path used only when a Managed Route
Binding selects GenioOne Secure Access delivery. In V1 the Endpoint connects to
a `boringtun` WireGuard listener embedded in the Secure Access Gateway; there
is no standalone relay deployable. The transport does not inspect TLS or decide
policy; its gateway dispatches to the binding's enforcement target.
_Avoid_: Every MANAGED route, forward proxy, physical private circuit

**Genio Gateway (`genio-gateway`)**:
The customer-side V1 deployment bundle, previously described as the Genio
Connector. It contains one Gateway Runtime and the capability modules installed
for that customer. Tier 1 commercially groups company AI/MCP reverse proxy, API
reverse proxy, and enterprise outbound forward proxy while retaining their
independent listeners, credential semantics and rollout. Tier 2 adds Endpoint
and may activate optional Secure Access. Gateway Runtime initiates an outbound Control Plane WebSocket,
applies desired state only to that installed set, reports observed state, and
exports telemetry with OTLP. Each module owns its data-plane ingress; Gateway
Runtime is not a synchronous request hop.
_Avoid_: Endpoint, central Control Plane, external Axway estate, complete SASE

**Gateway Group**:
A Tenant-scoped logical Gateway deployment selected as one Publication target.
One release fans out to every eligible Runtime Replica in the selected group;
another group is a distinct placement target, not another replica candidate.
_Avoid_: Runtime pod, single Gateway Runtime, replica

**Gateway Runtime Replica**:
One independently observed instance in a Gateway Group. Replicas share the
group's desired release identity but acknowledge, apply and report health under
their own Runtime identity.
_Avoid_: Gateway Group, Publication target

**Genio AI/MCP Gateway**:
The Genio-owned ingress wrapper for company-managed AI and MCP capabilities.
It projects Resource-owned Connections, Entitlements, One Policy decisions and
ordered Enforcement Chains into Envoy AI Gateway and Gateway API configuration;
native protocol, provider, routing and telemetry behavior stays with that
substrate, while bounded extensions cover only unsupported policy behavior. The
deprecated Rust `ai-mcp-processor` is not a target runtime component.
_Avoid_: Official-provider egress, caller token as upstream credential,
Traditional APIM, custom replacement for native Envoy AI Gateway behavior,
One Policy source of truth

**Genio Access Gateway**:
The Tier 1 outbound forward-proxy capability inside `genio-gateway` for governing Codex and
other applications while they call governed HTTP destinations. It uses
a second dedicated Envoy runtime, separate from the Ingress Envoy listener and
rollout. GenioOne identity comes from verified Endpoint/process/session
evidence or explicit egress authentication; an OpenAI, xAI or other provider
OAuth token/API key remains an upstream credential and must not be interpreted
as a GenioOne Entitlement token. The Egress runtime applies outbound policy,
guardrails, accounting and audit, then either passes the approved provider
credential or uses an explicitly selected managed credential. Secure Access
WireGuard is an optional transport into this runtime, not the L7 policy engine.
Without Endpoint, coverage is limited to traffic steered through a
customer-controlled enterprise network and the identity evidence available at
that egress path; it does not imply roaming or process-level coverage.
_Avoid_: Company-published AI API, shared Ingress listener, provider API key as
Subject identity, WireGuard as authorization

**Runtime Control Channel**:
The runtime-initiated outbound WebSocket from Endpoint Runtime or Gateway
Runtime to `genio-one-platform`. The GenioOne Product API and canonical desired
state stay in Platform; commands travel down and acknowledgements/observed state
travel up on the same full-duplex session.
Runtimes expose no inbound management listener and the channel never handles
synchronous client traffic.
_Avoid_: Gateway-local Management API, data tunnel, canonical Entitlement store

**Runtime Telemetry Export**:
Endpoint Runtime and Gateway Runtime export activity, metrics, traces and logs
through OTLP to Platform telemetry ingest. ClickHouse is the high-volume
telemetry/analytics store; PostgreSQL remains canonical for One Policy,
Entitlement, desired state and lifecycle truth.
_Avoid_: WebSocket command payload, authorization source of truth, replacement for PostgreSQL

**External APIM Integration**:
The External Provider Integration from `genio-one-platform` to an existing
enterprise APIM estate such as Axway. It uses supported management APIs or
Agents for discovery, entitlement projection and reconciliation. Axway remains
outside the `genio-gateway` delivery and its existing data path remains direct.
_Avoid_: bundled runtime slot, Connector request hop, Axway internal database contract

**Genio API Gateway (`API Gateway`)**:
The customer-side reverse-proxy capability that publishes governed API
Resources and applies inbound identity, One Policy, request mapping, routing
and telemetry. It remains directly usable without Endpoint and is distinct
from an External APIM Integration.
_Avoid_: Traditional APIM, Gravitee, API Management provider, Endpoint tunnel,
forward proxy

**Desired State / Observed State**:
The versioned configuration the Control Plane wants an Endpoint Runtime or
Gateway Runtime to apply, and the version and health that runtime actually
reports. They must not be collapsed into one optimistic status.
_Avoid_: Current config

**Gateway Desired State Rollback**:
A Tenant Administrator operation that republishes a previously observed
`READY` Gateway Desired State to an explicit Runtime fleet after a failed
revision. Report history, not a mutable latest-state pointer, proves the target
was successful. Each Runtime receives an idempotent successor command; canonical
Audit records failed and target revisions, while Runtime inventory remains the
authority for eventual fleet convergence.
_Avoid_: provider-local undo, unverified config snapshot, silently mutating command history

**Tenant Configuration Revision**:
An immutable Tenant-owned revision for self-service and Control Plane settings.
It moves through `Draft → Validated → Reviewed → Published`; Validate, Preview,
Review and Publish are separately audited. Published revisions expose the
desired revision, observed revision, projection status, drift, retry count and
rollback provenance. A Draft never changes the live Self-service view.
_Avoid_: mutable settings row, browser-only draft, provider config as authority

**Self-service Tenant Configuration**:
The published projection of a Tenant Configuration Revision that controls
brand, language, Catalog visibility, request-form fields, TTL choices,
approval-workflow version and available notification channels. Self-service
reads this projection; it cannot publish or bypass the Management lifecycle.
The Control Plane owns and activates this read projection. These settings are
not Gateway Desired State because they do not configure the data path; a
Gateway or Endpoint projection is required only for a future setting whose
runtime effect actually belongs to that Runtime.
_Avoid_: per-browser preferences, identity-provider profile, Catalog mutation

**Notification Subscription**:
A durable, Tenant-scoped binding between a canonical Subject, notification type,
and delivery channel (`IN_APP`, `EMAIL`, or `IM`). The Subject may manage its
own subscriptions; another Subject requires Tenant Administrator authority.
Changes are canonical Audit Events and disabling one subscription does not
alter another.
_Avoid_: email preference cookie, implicit role broadcast, provider webhook as authority

**Gateway Registration Lifecycle**:
The canonical lifecycle for one installed Gateway identity. `Active` means its
provider identity may authenticate and it is eligible for Runtime inventory and
fleet readiness. `Stale` is a derived observation, not a canonical mutation:
an Active registration whose Runtime health report exceeded the configured
timeout remains recoverable but is excluded from READY traffic candidates.
`Retired` is a terminal, planned decommission; `Revoked` is a terminal security
response. Both disable the provider identity and disappear from active Runtime
inventory, Overview readiness, and alerts. The canonical registration and its
Audit Events are retained for the Tenant's audit retention period; production
operations never delete that provenance. Development and contract cleanup use
the same Product API retirement operation instead of deleting rows directly.
_Avoid_: deleting a registration, treating stale as revoked, test-only database cleanup

**Audit Event**:
An immutable, correlated record of identity, Resource, Capability, decision,
enforcement, result, and relevant versions. Analytics storage is not its
transactional source of truth.
_Avoid_: Log line, raw prompt by default

**API Transaction Detail**:
A short-lived operational record linked from an API Gateway Activity by its
correlation ID. It may retain sanitized request and response headers and bodies
for incident investigation. Credential values are always removed, access to
the detail is separate from access to Activity metadata, and expiry removes the
detail without deleting the canonical Activity or Audit Event.
_Avoid_: Audit Event payload, credential archive, AI prompt history

**MCP Compatibility Observation**:
Runtime evidence describing one MCP Connection's observed protocol
version, transport, deprecated protocol features, and recommended migration
targets. It informs validation but never creates a Capability or changes an
already Published Resource by itself.
_Avoid_: MCP Capability, Tenant policy, published Resource revision

**MCP Deprecation Policy**:
The Tenant-owned, versioned Warning or Blocked disposition for each deprecated
MCP feature and transport. Runtime enforces the projected disposition at every
request boundary; a Resource Owner acknowledgement permits publication under a
Warning but never overrides a Blocked disposition.
_Avoid_: Connection health, protocol support list, per-Resource exception

**Deprecated MCP Usage**:
Correlated request evidence that a Client used an MCP feature or transport
classified as deprecated. It remains distinct from normal usage and records the
feature or transport, protocol version, disposition, Resource, Connection and
Acting Client without retaining raw payload.
_Avoid_: deprecation configuration, generic warning log, Capability usage

## Roadmap boundary

- V1 Core: Platform, Self-service, One Policy, access lifecycle, audit, and the
  Endpoint enforcement/runtime foundation. The V1 BDD gate is frozen: in-scope
  Product E2E Pass on the original V1 verification list; Entra directory
  scenarios remain out of scope; Secure Access network-state scenarios stay
  non-blocking. Do not reopen that list by adding or rewriting V1 story IDs.
- V1 capability modules: AI/MCP Gateway and API Management; install only the
  capabilities required by a deployment. Every V1 capability has at least one
  Bundled Product Substrate even when external provider integrations also exist.
- Optional module: GenioOne Secure Access for encrypted managed delivery into
  AI/MCP, API or private-resource targets. Optional means separately installable,
  not dependent on another vendor product. Existing Firezone or enterprise ZTNA
  may satisfy compatible external provider bindings.
- V1.1: UX and contract hardening that keeps the V1 domain vocabulary
  (Resource, Connection, Capability, Entitlement, Application API Credential,
  Credential Lease, Managed Route Binding) and now names the canonical
  `Tenant Configuration Revision`, `Self-service Tenant Configuration` and
  `Notification Subscription` models above. It covers recoverable first-run,
  type-first onboarding, management Requests versus Entitlements, `subject_kind`,
  the capacity-key defect, OAuth Client Credentials as an additional inbound
  authenticator, MCP per-request admission, immutable configuration
  lifecycle/projection, and permission-bounded notification routing. New
  stories use a separate verification list and the Product E2E contract; they
  do not rewrite V1 Gherkin. Exposure, Backend, Authenticator and Access Binding
  are not V1 product aggregates and remain outside this model. V1.1
  keeps policy evaluation deterministic first-match: obligations are the
  obligations on the winning rule, with unsupported obligations failing closed.
  A Tenant-level mandatory-obligation baseline/merge model and deprecated MCP
  transport/feature lifecycle are not V1.1 contracts; adopting either requires
  a later CONTEXT/ADR decision and a new Product E2E lane.
- V1.5: Epic 12–18. AI Gateway is the primary runtime capability. It adds
  provider-aware LLM Connection profiles, stable Public Models, entitlement-
  constrained and semantic model selection, session-scoped Model Route Leases,
  native Envoy AI Gateway routing and telemetry, ordered Enforcement Chains,
  reversible sensitive-data tokenization, DLP processing, cost accounting and
  governed MCP proxying. Usage Policy revisions use explicit opaque accounting
  keys to aggregate shared capacity without a generic CapacityGroup. It also
  covers Application credential lifecycle and workload federation, Trusted
  Decision Context and mandatory obligations, unified evidence and runtime
  convergence, and Agent SELF, Delegation, Execution Grant and A2A authority.
  It keeps the Resource-owned Connection model from ADR 0014 and does not
  restore independent Exposure or Backend aggregates. Agent authentication may
  reuse the same NHI and Credential Lease primitives, while Agent authority is
  still constrained by Agent Delegation, Agent Acting Chain, Entitlement and
  One Policy. Epic 19 and later work is outside the active V1.5 scope.
  New V1.5 terms
  and aggregate boundaries enter the canonical product model only when
  the owning ADR defines their semantics, lifecycle, projection, and Product
  E2E lane.
- V2: first-party `genio-one-agent` on the shared `genio-agent` framework.

## Sources

- [GenioOne project](https://app.notion.com/p/3be3be7297e2816aa02ae215b28bb6b3)
- [GenioOne Agent positioning](https://app.notion.com/p/3be3be7297e28196b90ec8bbb451981d)
- [GenioOne V1 User Stories and BDD](https://app.notion.com/p/3be3be7297e2817cbe24ec7d6de23a9e)
- [GenioOne Canonical Epic 12–22](https://app.notion.com/p/3ce3be7297e2811b906ec27203d7fbc5)
