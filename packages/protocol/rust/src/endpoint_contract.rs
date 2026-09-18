use std::{collections::BTreeSet, error::Error, fmt};

use serde::{Deserialize, Serialize};

use crate::{
    ActingClientEvidence, ActingClientId, CorrelationId, DesiredStateRevision, DeviceId,
    EndpointActivityId, EndpointVersion, EnforcementPointId, EnforcementProviderId, EvidenceLevel,
    ManagedRouteBinding, PolicyRuleId, PolicyVersion, ResourceId, RuntimeControlCommandId,
    RuntimeId, SubjectEvidence, SubjectId, TenantId, Timestamp,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IdentityContext {
    pub subject: SubjectEvidence,
    pub acting_client: ActingClientEvidence,
    pub device_id: Option<DeviceId>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DeviceLifecycleState {
    Active,
    Revoked,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EndpointHealth {
    Unknown,
    Healthy,
    Degraded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DeviceEvidence {
    pub device_id: DeviceId,
    pub subject: SubjectEvidence,
    pub evidence_level: EvidenceLevel,
}

impl DeviceEvidence {
    pub fn matches_enrolled_subject(&self, enrolled_subject: &SubjectId) -> bool {
        self.evidence_level == EvidenceLevel::Verified
            && self.subject.evidence_level == EvidenceLevel::Verified
            && &self.subject.subject_id == enrolled_subject
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointManagedRoute {
    pub enforcement_point_id: EnforcementPointId,
    pub binding: ManagedRouteBinding,
    pub delivery: EndpointManagedDelivery,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EndpointDeploymentCapability {
    ManagedHttpProxy,
    ProviderTransport,
    SecureAccess,
}

impl EndpointDeploymentCapability {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ManagedHttpProxy => "MANAGED_HTTP_PROXY",
            Self::ProviderTransport => "PROVIDER_TRANSPORT",
            Self::SecureAccess => "SECURE_ACCESS",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EndpointManagedDelivery {
    HttpProxy {
        proxy_url: String,
    },
    ProviderTransport {
        transport_provider_id: EnforcementProviderId,
        route_reference: String,
    },
    SecureAccess {
        peer_lease: Box<crate::PeerLease>,
        route_projection: Box<crate::RouteProjection>,
    },
}

impl EndpointManagedRoute {
    pub const fn required_deployment_capability(&self) -> EndpointDeploymentCapability {
        match &self.delivery {
            EndpointManagedDelivery::HttpProxy { .. } => {
                EndpointDeploymentCapability::ManagedHttpProxy
            }
            EndpointManagedDelivery::ProviderTransport { .. } => {
                EndpointDeploymentCapability::ProviderTransport
            }
            EndpointManagedDelivery::SecureAccess { .. } => {
                EndpointDeploymentCapability::SecureAccess
            }
        }
    }

    pub fn proxy_url(&self) -> Option<&str> {
        match &self.delivery {
            EndpointManagedDelivery::HttpProxy { proxy_url } => Some(proxy_url),
            EndpointManagedDelivery::ProviderTransport { .. }
            | EndpointManagedDelivery::SecureAccess { .. } => None,
        }
    }

    fn validate(&self, resource_id: &ResourceId) -> bool {
        if self.enforcement_point_id.as_str().is_empty()
            || self.binding.provider_id.as_str().is_empty()
        {
            return false;
        }
        match &self.delivery {
            EndpointManagedDelivery::HttpProxy { proxy_url } => !proxy_url.trim().is_empty(),
            EndpointManagedDelivery::ProviderTransport {
                transport_provider_id,
                route_reference,
            } => !transport_provider_id.as_str().is_empty() && !route_reference.trim().is_empty(),
            EndpointManagedDelivery::SecureAccess {
                peer_lease,
                route_projection,
            } => {
                peer_lease.validate().is_ok()
                    && route_projection.validate().is_ok()
                    && route_projection.peer_lease_id == peer_lease.peer_lease_id
                    && route_projection.resource_id == *resource_id
                    && route_projection.binding == self.binding
                    && route_projection.binding.provider_id == peer_lease.provider_id
                    && route_projection.generation == peer_lease.generation
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointRoutingRule {
    pub policy_rule_id: PolicyRuleId,
    pub resource_id: ResourceId,
    pub host_suffix: String,
    pub route: crate::RouteDecision,
    pub managed_route: Option<EndpointManagedRoute>,
    pub policy_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_compliance: Option<EndpointClientComplianceRequirement>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointClientComplianceRequirement {
    pub acting_client_id: ActingClientId,
    pub managed_configuration_revision: String,
    pub otel_collector_origin: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointClientConfigurationObservation {
    pub managed_configuration_revision: Option<String>,
    pub otel_collector_origin: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EndpointClientComplianceState {
    Compliant,
    NonCompliant,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EndpointClientComplianceIssue {
    ManagedConfiguration,
    OtelConfiguration,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointClientComplianceDecision {
    pub state: EndpointClientComplianceState,
    pub issues: Vec<EndpointClientComplianceIssue>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointRoutingBundle {
    pub default_route: crate::RouteDecision,
    pub rules: Vec<EndpointRoutingRule>,
}

impl Default for EndpointRoutingBundle {
    fn default() -> Self {
        Self {
            default_route: crate::RouteDecision::Direct,
            rules: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointRouteResolution {
    pub policy_rule_id: Option<PolicyRuleId>,
    pub resource_id: Option<ResourceId>,
    pub route: crate::RouteDecision,
    pub managed_route: Option<EndpointManagedRoute>,
    pub policy_message: Option<String>,
    #[serde(default)]
    pub missing_deployment_capability: Option<EndpointDeploymentCapability>,
}

impl EndpointRouteResolution {
    pub fn fail_closed_for_missing_capability(
        &self,
        capability: EndpointDeploymentCapability,
    ) -> Result<Self, EndpointRoutingError> {
        let managed_route = self
            .managed_route
            .as_ref()
            .ok_or(EndpointRoutingError::InvalidDesiredState)?;
        if self.route != crate::RouteDecision::Managed
            || managed_route.required_deployment_capability() != capability
        {
            return Err(EndpointRoutingError::InvalidDesiredState);
        }
        Ok(Self {
            policy_rule_id: self.policy_rule_id.clone(),
            resource_id: self.resource_id.clone(),
            route: crate::RouteDecision::Block,
            managed_route: None,
            policy_message: Some(format!(
                "Required deployment capability {} is not installed.",
                capability.as_str()
            )),
            missing_deployment_capability: Some(capability),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointDesiredState {
    pub revision: DesiredStateRevision,
    pub policy_version: PolicyVersion,
    pub routing: EndpointRoutingBundle,
}

impl EndpointDesiredState {
    pub fn validate(&self) -> Result<(), EndpointRoutingError> {
        if self.revision.as_str().is_empty() || self.policy_version.as_str().is_empty() {
            return Err(EndpointRoutingError::InvalidDesiredState);
        }
        self.routing.validate()
    }

    pub fn resolve_destination(
        &self,
        destination_host: &str,
    ) -> Result<EndpointRouteResolution, EndpointRoutingError> {
        self.validate()?;
        self.routing.resolve_destination(destination_host)
    }

    pub fn resolve_client_destination(
        &self,
        destination_host: &str,
        acting_client: &ActingClientEvidence,
        observation: Option<&EndpointClientConfigurationObservation>,
    ) -> Result<
        (
            EndpointRouteResolution,
            Option<EndpointClientComplianceDecision>,
        ),
        EndpointRoutingError,
    > {
        self.validate()?;
        self.routing
            .resolve_client_destination(destination_host, acting_client, observation)
    }
}

impl EndpointRoutingBundle {
    fn validate(&self) -> Result<(), EndpointRoutingError> {
        if self.default_route != crate::RouteDecision::Direct {
            return Err(EndpointRoutingError::InvalidDesiredState);
        }
        let mut suffixes = BTreeSet::new();
        for rule in &self.rules {
            if rule.policy_rule_id.as_str().is_empty()
                || rule.resource_id.as_str().is_empty()
                || !is_canonical_host(&rule.host_suffix)
                || !suffixes.insert(rule.host_suffix.as_str())
            {
                return Err(EndpointRoutingError::InvalidDesiredState);
            }
            match rule.route {
                crate::RouteDecision::Direct
                    if rule.managed_route.is_none() && rule.policy_message.is_none() => {}
                crate::RouteDecision::Managed
                    if rule.policy_message.is_none()
                        && rule
                            .managed_route
                            .as_ref()
                            .is_some_and(|route| route.validate(&rule.resource_id)) => {}
                crate::RouteDecision::Block
                    if rule.managed_route.is_none()
                        && rule
                            .policy_message
                            .as_ref()
                            .is_some_and(|message| !message.trim().is_empty()) => {}
                _ => return Err(EndpointRoutingError::InvalidDesiredState),
            }
            if let Some(requirement) = &rule.client_compliance {
                if rule.route != crate::RouteDecision::Managed
                    || requirement.acting_client_id.as_str().is_empty()
                    || requirement.managed_configuration_revision.trim().is_empty()
                    || requirement.otel_collector_origin.trim().is_empty()
                {
                    return Err(EndpointRoutingError::InvalidDesiredState);
                }
            }
        }
        Ok(())
    }

    fn resolve_client_destination(
        &self,
        destination_host: &str,
        acting_client: &ActingClientEvidence,
        observation: Option<&EndpointClientConfigurationObservation>,
    ) -> Result<
        (
            EndpointRouteResolution,
            Option<EndpointClientComplianceDecision>,
        ),
        EndpointRoutingError,
    > {
        let resolution = self.resolve_destination(destination_host)?;
        let Some(rule) = resolution.policy_rule_id.as_ref().and_then(|rule_id| {
            self.rules
                .iter()
                .find(|rule| rule.policy_rule_id == *rule_id)
        }) else {
            return Ok((resolution, None));
        };
        let Some(requirement) = &rule.client_compliance else {
            return Ok((resolution, None));
        };
        let is_target_client = acting_client.evidence_level == EvidenceLevel::Verified
            && acting_client.acting_client_id.as_ref() == Some(&requirement.acting_client_id);
        if !is_target_client {
            return Ok((resolution, None));
        }
        let mut issues = Vec::new();
        if observation.and_then(|value| value.managed_configuration_revision.as_deref())
            != Some(requirement.managed_configuration_revision.as_str())
        {
            issues.push(EndpointClientComplianceIssue::ManagedConfiguration);
        }
        if observation.and_then(|value| value.otel_collector_origin.as_deref())
            != Some(requirement.otel_collector_origin.as_str())
        {
            issues.push(EndpointClientComplianceIssue::OtelConfiguration);
        }
        let state = if issues.is_empty() {
            EndpointClientComplianceState::Compliant
        } else {
            EndpointClientComplianceState::NonCompliant
        };
        let resolution = if state == EndpointClientComplianceState::Compliant {
            EndpointRouteResolution {
                route: crate::RouteDecision::Direct,
                managed_route: None,
                policy_message: None,
                ..resolution
            }
        } else {
            resolution
        };
        Ok((
            resolution,
            Some(EndpointClientComplianceDecision { state, issues }),
        ))
    }

    fn resolve_destination(
        &self,
        destination_host: &str,
    ) -> Result<EndpointRouteResolution, EndpointRoutingError> {
        let destination_host = canonical_destination(destination_host)?;
        let matched = self.rules.iter().find(|rule| {
            destination_host == rule.host_suffix
                || destination_host
                    .strip_suffix(&rule.host_suffix)
                    .is_some_and(|prefix| prefix.ends_with('.'))
        });
        Ok(match matched {
            Some(rule) => EndpointRouteResolution {
                policy_rule_id: Some(rule.policy_rule_id.clone()),
                resource_id: Some(rule.resource_id.clone()),
                route: rule.route,
                managed_route: rule.managed_route.clone(),
                policy_message: rule.policy_message.clone(),
                missing_deployment_capability: None,
            },
            None => EndpointRouteResolution {
                policy_rule_id: None,
                resource_id: None,
                route: self.default_route,
                managed_route: None,
                policy_message: None,
                missing_deployment_capability: None,
            },
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EndpointRoutingError {
    InvalidDesiredState,
    InvalidDestination,
}

impl fmt::Display for EndpointRoutingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidDesiredState => {
                "endpoint desired state contains an invalid routing bundle"
            }
            Self::InvalidDestination => "endpoint destination host is invalid",
        })
    }
}

impl Error for EndpointRoutingError {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointConfiguration {
    pub heartbeat_interval_seconds: u64,
    pub stale_after_seconds: u64,
    pub desired_state: EndpointDesiredState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointObservedState {
    pub endpoint_version: EndpointVersion,
    pub applied_state_revision: Option<DesiredStateRevision>,
    pub applied_policy_version: Option<PolicyVersion>,
    pub health: EndpointHealth,
    pub reported_at: Timestamp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RegisteredDevice {
    pub tenant_id: TenantId,
    pub device_id: DeviceId,
    pub subject_id: SubjectId,
    pub lifecycle_state: DeviceLifecycleState,
    pub enrolled_at: Timestamp,
    pub last_seen_at: Timestamp,
    pub observed_state: EndpointObservedState,
    pub revocation_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EnrollEndpointCommand {
    pub correlation_id: CorrelationId,
    pub identity: IdentityContext,
    pub device_id: DeviceId,
    pub endpoint_version: EndpointVersion,
    pub at: Timestamp,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointRuntimeCredential {
    pub token: String,
    pub expires_at: u64,
}

impl std::fmt::Debug for EndpointRuntimeCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EndpointRuntimeCredential")
            .field("token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointEnrollment {
    pub runtime_credential: Option<EndpointRuntimeCredential>,
    pub device: RegisteredDevice,
    pub configuration: EndpointConfiguration,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointHeartbeatCommand {
    pub correlation_id: CorrelationId,
    pub device: DeviceEvidence,
    pub endpoint_version: EndpointVersion,
    pub applied_state_revision: Option<DesiredStateRevision>,
    pub applied_policy_version: Option<PolicyVersion>,
    pub health: EndpointHealth,
    pub at: Timestamp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointHeartbeatOutcome {
    pub device: RegisteredDevice,
    pub desired_state: Option<EndpointDesiredState>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointEnforcementCommand {
    pub correlation_id: CorrelationId,
    pub device: DeviceEvidence,
    pub destination_host: String,
    pub acting_client: ActingClientEvidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_configuration: Option<EndpointClientConfigurationObservation>,
    pub applied_state_revision: DesiredStateRevision,
    pub applied_policy_version: PolicyVersion,
    pub route: crate::RouteDecision,
    #[serde(default)]
    pub missing_deployment_capability: Option<EndpointDeploymentCapability>,
    pub at: Timestamp,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EndpointActivityKind {
    Discovery,
    Usage,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EndpointActivityResourceClass {
    Known,
    Unclassified,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EndpointClientAttribution {
    Unknown,
    Verified { acting_client_id: ActingClientId },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointActivityCommand {
    pub correlation_id: CorrelationId,
    pub device: DeviceEvidence,
    pub destination_host: String,
    pub acting_client: ActingClientEvidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_configuration: Option<EndpointClientConfigurationObservation>,
    pub applied_state_revision: DesiredStateRevision,
    pub applied_policy_version: PolicyVersion,
    pub route: crate::RouteDecision,
    pub request_count: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub observed_at: Timestamp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointActivityEvent {
    pub activity_id: EndpointActivityId,
    pub correlation_id: CorrelationId,
    pub kind: EndpointActivityKind,
    pub tenant_id: TenantId,
    pub subject_id: SubjectId,
    pub device_id: DeviceId,
    pub destination_host: String,
    pub resource_id: ResourceId,
    pub resource_class: EndpointActivityResourceClass,
    pub client: EndpointClientAttribution,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_compliance: Option<EndpointClientComplianceDecision>,
    pub route: crate::RouteDecision,
    pub routing_policy_rule_id: Option<PolicyRuleId>,
    pub applied_state_revision: DesiredStateRevision,
    pub applied_policy_version: PolicyVersion,
    pub request_count: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub observed_at: Timestamp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointActivityResourceSummary {
    pub resource_id: ResourceId,
    pub resource_class: EndpointActivityResourceClass,
    pub destination_hosts: Vec<String>,
    pub subjects: Vec<SubjectId>,
    pub devices: Vec<DeviceId>,
    pub clients: Vec<EndpointClientAttribution>,
    pub routes: Vec<crate::RouteDecision>,
    pub first_seen_at: Timestamp,
    pub last_seen_at: Timestamp,
    pub request_count: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointActivityInventory {
    pub resources: Vec<EndpointActivityResourceSummary>,
    pub recent_activity: Vec<EndpointActivityEvent>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeKind {
    Endpoint,
    Gateway,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "runtime_kind",
    content = "desired_state",
    rename_all = "SCREAMING_SNAKE_CASE"
)]
pub enum RuntimeDesiredState {
    Endpoint(EndpointDesiredState),
    Gateway(serde_json::Value),
}

impl RuntimeDesiredState {
    pub fn runtime_kind(&self) -> RuntimeKind {
        match self {
            Self::Endpoint(_) => RuntimeKind::Endpoint,
            Self::Gateway(_) => RuntimeKind::Gateway,
        }
    }

    fn validate(&self) -> Result<(), RuntimeControlContractError> {
        match self {
            Self::Endpoint(state) => state
                .validate()
                .map_err(|_| RuntimeControlContractError::InvalidDesiredState),
            Self::Gateway(_) => Err(RuntimeControlContractError::WrongRuntimeKind),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RuntimeControlCommand {
    pub command_id: RuntimeControlCommandId,
    pub desired_state: RuntimeDesiredState,
}

impl RuntimeControlCommand {
    pub fn validate_for(
        &self,
        runtime_kind: RuntimeKind,
    ) -> Result<(), RuntimeControlContractError> {
        if self.command_id.as_str().is_empty() || self.desired_state.runtime_kind() != runtime_kind
        {
            return Err(RuntimeControlContractError::WrongRuntimeKind);
        }
        self.desired_state.validate()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeHealth {
    Ready,
    Degraded,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RuntimeControlReport {
    pub command_id: RuntimeControlCommandId,
    pub runtime_id: RuntimeId,
    pub runtime_kind: RuntimeKind,
    pub runtime_version: String,
    pub applied_state_revision: DesiredStateRevision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_policy_version: Option<PolicyVersion>,
    pub health: RuntimeHealth,
    #[serde(default)]
    pub components: Vec<serde_json::Value>,
    #[serde(default)]
    pub secure_access: Vec<crate::SecureAccessObservation>,
}

impl RuntimeControlReport {
    pub fn validate_for(
        &self,
        runtime_kind: RuntimeKind,
        runtime_id: &RuntimeId,
    ) -> Result<(), RuntimeControlContractError> {
        let secure_access_sessions = self
            .secure_access
            .iter()
            .map(|observation| {
                (
                    observation.access_session_id.clone(),
                    observation.generation,
                )
            })
            .collect::<BTreeSet<_>>();
        if self.command_id.as_str().is_empty()
            || self.runtime_id != *runtime_id
            || self.runtime_kind != runtime_kind
            || self.runtime_version.trim().is_empty()
            || self.runtime_version.len() > 64
            || self.applied_state_revision.as_str().is_empty()
            || secure_access_sessions.len() != self.secure_access.len()
            || self
                .secure_access
                .iter()
                .any(|observation| observation.validate().is_err())
            || runtime_kind != RuntimeKind::Endpoint
            || !self.components.is_empty()
        {
            return Err(RuntimeControlContractError::InvalidReport);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeControlContractError {
    InvalidDesiredState,
    WrongRuntimeKind,
    InvalidReport,
}

fn canonical_destination(destination: &str) -> Result<String, EndpointRoutingError> {
    let value = destination
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if !is_canonical_host(&value) {
        return Err(EndpointRoutingError::InvalidDestination);
    }
    Ok(value)
}

fn is_canonical_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && !value.contains(char::is_whitespace)
        && !value.contains(['/', '\\', ':', '@'])
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}
