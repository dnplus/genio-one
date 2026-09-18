use std::collections::BTreeSet;
use std::error::Error;
use std::fmt;
use std::net::{IpAddr, SocketAddr};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

use crate::{
    AccessSessionId, DeviceId, EnforcementProviderId, ManagedRouteBinding, PeerLeaseId, ResourceId,
    RuntimeId, Timestamp,
};

pub const MAX_PEER_LEASE_SECONDS: u64 = 300;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct SecureAccessGeneration(u64);

impl SecureAccessGeneration {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn value(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PeerLease {
    pub peer_lease_id: PeerLeaseId,
    pub access_session_id: AccessSessionId,
    pub endpoint_device_id: DeviceId,
    pub gateway_runtime_id: RuntimeId,
    pub provider_id: EnforcementProviderId,
    pub endpoint_public_key: String,
    pub gateway_public_key: String,
    pub gateway_endpoint: String,
    pub endpoint_allowed_networks: Vec<String>,
    pub gateway_allowed_networks: Vec<String>,
    pub persistent_keepalive_seconds: u16,
    pub generation: SecureAccessGeneration,
    pub issued_at: Timestamp,
    pub expires_at: Timestamp,
}

impl PeerLease {
    pub fn validate(&self) -> Result<(), SecureAccessContractError> {
        let lease_seconds = self
            .expires_at
            .unix_seconds()
            .checked_sub(self.issued_at.unix_seconds())
            .filter(|seconds| *seconds > 0 && *seconds <= MAX_PEER_LEASE_SECONDS)
            .ok_or(SecureAccessContractError::InvalidPeerLease)?;
        if lease_seconds == 0
            || self.peer_lease_id.as_str().trim().is_empty()
            || self.access_session_id.as_str().trim().is_empty()
            || self.endpoint_device_id.as_str().trim().is_empty()
            || self.gateway_runtime_id.as_str().trim().is_empty()
            || self.provider_id.as_str().trim().is_empty()
            || self.generation.value() == 0
            || !is_wireguard_public_key(&self.endpoint_public_key)
            || !is_wireguard_public_key(&self.gateway_public_key)
            || self.endpoint_public_key == self.gateway_public_key
            || self.gateway_endpoint.parse::<SocketAddr>().is_err()
            || is_turn_uri(&self.gateway_endpoint)
            || self.endpoint_allowed_networks.is_empty()
            || self.gateway_allowed_networks.is_empty()
            || self
                .endpoint_allowed_networks
                .iter()
                .any(|network| !is_network_prefix(network))
            || self
                .gateway_allowed_networks
                .iter()
                .any(|network| !is_network_prefix(network))
        {
            return Err(SecureAccessContractError::InvalidPeerLease);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RouteProjection {
    pub peer_lease_id: PeerLeaseId,
    pub resource_id: ResourceId,
    pub binding: ManagedRouteBinding,
    pub route_reference: String,
    pub dns_names: Vec<String>,
    pub network_prefixes: Vec<String>,
    pub generation: SecureAccessGeneration,
}

impl RouteProjection {
    pub fn validate(&self) -> Result<(), SecureAccessContractError> {
        if self.peer_lease_id.as_str().trim().is_empty()
            || self.resource_id.as_str().trim().is_empty()
            || self.binding.provider_id.as_str().trim().is_empty()
            || self.route_reference.trim().is_empty()
            || self.generation.value() == 0
            || (self.dns_names.is_empty() && self.network_prefixes.is_empty())
            || self.dns_names.iter().any(|name| !is_dns_name(name))
            || self
                .network_prefixes
                .iter()
                .any(|network| !is_network_prefix(network))
        {
            return Err(SecureAccessContractError::InvalidRouteProjection);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SecureAccessDesiredState {
    pub interface_name: String,
    pub listen_port: u16,
    pub peers: Vec<PeerLease>,
    pub routes: Vec<RouteProjection>,
    /// Optional TURN allocation for the transport seam. This is not a WireGuard
    /// peer endpoint; pointing `PeerLease.gateway_endpoint` at the TURN socket
    /// is rejected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<SecureAccessRelayAllocation>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SecureAccessRelayAllocation {
    pub allocation_id: String,
    pub turn_uri: String,
}

impl SecureAccessRelayAllocation {
    pub fn validate(&self) -> Result<(), SecureAccessContractError> {
        if self.allocation_id.trim().is_empty() || !is_turn_uri(&self.turn_uri) {
            return Err(SecureAccessContractError::InvalidDesiredState);
        }
        let _ = self.socket()?;
        Ok(())
    }

    pub fn socket(&self) -> Result<SocketAddr, SecureAccessContractError> {
        let without_scheme = self
            .turn_uri
            .split_once(':')
            .map(|(_, rest)| rest)
            .unwrap_or(self.turn_uri.as_str());
        let hostport = without_scheme
            .trim_start_matches('/')
            .split('?')
            .next()
            .unwrap_or(without_scheme);
        hostport
            .parse::<SocketAddr>()
            .map_err(|_| SecureAccessContractError::InvalidDesiredState)
    }
}

impl SecureAccessDesiredState {
    pub fn validate(&self) -> Result<(), SecureAccessContractError> {
        if !is_interface_name(&self.interface_name)
            || self.listen_port == 0
            || self.peers.is_empty()
            || self.routes.is_empty()
        {
            return Err(SecureAccessContractError::InvalidDesiredState);
        }
        if let Some(relay) = &self.relay {
            relay.validate()?;
            let turn_socket = relay.socket()?;
            if self.peers.iter().any(|peer| {
                peer.gateway_endpoint
                    .parse::<SocketAddr>()
                    .is_ok_and(|endpoint| endpoint == turn_socket)
            }) {
                return Err(SecureAccessContractError::InvalidDesiredState);
            }
        }

        let mut peer_ids = BTreeSet::new();
        let mut sessions = BTreeSet::new();
        for peer in &self.peers {
            peer.validate()?;
            if !peer_ids.insert(peer.peer_lease_id.clone())
                || !sessions.insert(peer.access_session_id.clone())
            {
                return Err(SecureAccessContractError::InvalidDesiredState);
            }
        }

        let peers = self
            .peers
            .iter()
            .map(|peer| (&peer.peer_lease_id, peer))
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut references = BTreeSet::new();
        for route in &self.routes {
            route.validate()?;
            let peer = peers
                .get(&route.peer_lease_id)
                .ok_or(SecureAccessContractError::InvalidRouteProjection)?;
            if !references.insert(route.route_reference.as_str())
                || route.binding.provider_id != peer.provider_id
                || route.generation != peer.generation
            {
                return Err(SecureAccessContractError::InvalidRouteProjection);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SecureAccessConnectionLifecycle {
    Requested,
    Connecting,
    Direct,
    Relayed,
    Draining,
    Closed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SecureAccessTransportMode {
    Direct,
    Relayed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SecureAccessObservation {
    pub access_session_id: AccessSessionId,
    pub generation: SecureAccessGeneration,
    pub lifecycle: SecureAccessConnectionLifecycle,
    pub transport_mode: Option<SecureAccessTransportMode>,
    pub endpoint_device_id: DeviceId,
    pub gateway_runtime_id: RuntimeId,
    pub last_error: Option<String>,
}

impl SecureAccessObservation {
    pub fn validate(&self) -> Result<(), SecureAccessContractError> {
        let transport_matches_lifecycle = match self.lifecycle {
            SecureAccessConnectionLifecycle::Direct => {
                self.transport_mode == Some(SecureAccessTransportMode::Direct)
            }
            SecureAccessConnectionLifecycle::Relayed => {
                self.transport_mode == Some(SecureAccessTransportMode::Relayed)
            }
            SecureAccessConnectionLifecycle::Requested
            | SecureAccessConnectionLifecycle::Connecting
            | SecureAccessConnectionLifecycle::Closed => self.transport_mode.is_none(),
            SecureAccessConnectionLifecycle::Draining => true,
        };
        if self.access_session_id.as_str().trim().is_empty()
            || self.endpoint_device_id.as_str().trim().is_empty()
            || self.gateway_runtime_id.as_str().trim().is_empty()
            || self.generation.value() == 0
            || !transport_matches_lifecycle
            || self
                .last_error
                .as_ref()
                .is_some_and(|error| error.trim().is_empty())
        {
            return Err(SecureAccessContractError::InvalidObservation);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecureAccessContractError {
    InvalidDesiredState,
    InvalidPeerLease,
    InvalidRouteProjection,
    InvalidObservation,
}

impl fmt::Display for SecureAccessContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidDesiredState => "Secure Access desired state is invalid",
            Self::InvalidPeerLease => "Secure Access peer lease is invalid",
            Self::InvalidRouteProjection => "Secure Access route projection is invalid",
            Self::InvalidObservation => "Secure Access observation is invalid",
        })
    }
}

impl Error for SecureAccessContractError {}

fn is_turn_uri(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("turn:") || lower.starts_with("turns:")
}

fn is_wireguard_public_key(value: &str) -> bool {
    STANDARD
        .decode(value)
        .is_ok_and(|decoded| decoded.len() == 32)
}

fn is_network_prefix(value: &str) -> bool {
    let Some((address, prefix)) = value.split_once('/') else {
        return false;
    };
    let Ok(address) = address.parse::<IpAddr>() else {
        return false;
    };
    let Ok(prefix) = prefix.parse::<u8>() else {
        return false;
    };
    match address {
        IpAddr::V4(_) => prefix <= 32,
        IpAddr::V6(_) => prefix <= 128,
    }
}

fn is_dns_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value == value.to_ascii_lowercase()
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

fn is_interface_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 15
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
