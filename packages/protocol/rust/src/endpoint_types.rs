use std::fmt;

use serde::{Deserialize, Serialize};

macro_rules! string_id {
    ($($name:ident),+ $(,)?) => {
        $(
            #[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
            #[serde(transparent)]
            pub struct $name(String);

            impl $name {
                pub fn as_str(&self) -> &str {
                    &self.0
                }
            }

            impl From<&str> for $name {
                fn from(value: &str) -> Self {
                    Self(value.to_owned())
                }
            }

            impl From<String> for $name {
                fn from(value: String) -> Self {
                    Self(value)
                }
            }

            impl fmt::Display for $name {
                fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                    formatter.write_str(&self.0)
                }
            }
        )+
    };
}

string_id!(
    TenantId,
    SubjectId,
    ActingClientId,
    DeviceId,
    EndpointVersion,
    DesiredStateRevision,
    ResourceId,
    PolicyVersion,
    PolicyRuleId,
    CorrelationId,
    EnforcementPointId,
    EnforcementProviderId,
    EndpointActivityId,
    RuntimeId,
    RuntimeControlCommandId,
    AccessSessionId,
    PeerLeaseId,
);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct Timestamp(u64);

impl Timestamp {
    pub const fn new(unix_seconds: u64) -> Self {
        Self(unix_seconds)
    }

    pub const fn unix_seconds(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvidenceLevel {
    Unknown,
    Asserted,
    Verified,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SubjectEvidence {
    pub subject_id: SubjectId,
    pub evidence_level: EvidenceLevel,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ActingClientEvidence {
    pub acting_client_id: Option<ActingClientId>,
    pub evidence_level: EvidenceLevel,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RouteDecision {
    Direct,
    Managed,
    Block,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ManagedRouteTarget {
    AiMcp,
    Api,
    PrivateResource,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagedRouteBinding {
    pub target: ManagedRouteTarget,
    pub provider_id: EnforcementProviderId,
}
