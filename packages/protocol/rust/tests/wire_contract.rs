use genio_one_domain::*;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::fmt::Debug;

fn roundtrip<T>(value: &T, wire: Value)
where
    T: Serialize + DeserializeOwned + PartialEq + Debug,
{
    assert_eq!(serde_json::to_value(value).unwrap(), wire);
    assert_eq!(&serde_json::from_value::<T>(wire).unwrap(), value);
}

fn peer_wire() -> Value {
    json!({
        "peer_lease_id": "peer-1", "access_session_id": "session-1",
        "endpoint_device_id": "device-1", "gateway_runtime_id": "gateway-1",
        "provider_id": "wireguard", "endpoint_public_key": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        "gateway_public_key": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
        "gateway_endpoint": "192.0.2.1:51820", "endpoint_allowed_networks": ["10.1.0.0/24"],
        "gateway_allowed_networks": ["10.2.0.0/24"], "persistent_keepalive_seconds": 25,
        "generation": 1, "issued_at": 1000, "expires_at": 1100
    })
}

fn route_wire() -> Value {
    json!({
        "peer_lease_id": "peer-1", "resource_id": "resource-1",
        "binding": {"target": "PRIVATE_RESOURCE", "provider_id": "wireguard"},
        "route_reference": "route-1", "dns_names": ["internal.example"],
        "network_prefixes": ["10.1.0.0/24"], "generation": 1
    })
}

#[test]
fn enum_names_match_the_external_screaming_snake_case_contract() {
    macro_rules! wire {
        ($value:expr, $name:literal) => {
            roundtrip(&$value, json!($name));
        };
    }
    wire!(RuntimeKind::Endpoint, "ENDPOINT");
    wire!(RuntimeKind::Gateway, "GATEWAY");
    wire!(RouteDecision::Direct, "DIRECT");
    wire!(RouteDecision::Managed, "MANAGED");
    wire!(RouteDecision::Block, "BLOCK");
    wire!(EvidenceLevel::Unknown, "UNKNOWN");
    wire!(EvidenceLevel::Asserted, "ASSERTED");
    wire!(EvidenceLevel::Verified, "VERIFIED");
    wire!(
        EndpointDeploymentCapability::ManagedHttpProxy,
        "MANAGED_HTTP_PROXY"
    );
    wire!(
        EndpointDeploymentCapability::ProviderTransport,
        "PROVIDER_TRANSPORT"
    );
    wire!(EndpointDeploymentCapability::SecureAccess, "SECURE_ACCESS");
    wire!(EndpointClientComplianceState::NonCompliant, "NON_COMPLIANT");
    wire!(
        EndpointClientComplianceIssue::ManagedConfiguration,
        "MANAGED_CONFIGURATION"
    );
    wire!(
        EndpointClientComplianceIssue::OtelConfiguration,
        "OTEL_CONFIGURATION"
    );
    wire!(SecureAccessConnectionLifecycle::Relayed, "RELAYED");
}

#[test]
fn enum_decoders_reject_unknown_variants_and_wrong_case() {
    for value in ["endpoint", "Endpoint", "UNKNOWN"] {
        assert!(serde_json::from_value::<RuntimeKind>(json!(value)).is_err());
    }
    assert!(serde_json::from_value::<RouteDecision>(json!("ALLOW")).is_err());
    assert!(serde_json::from_value::<EvidenceLevel>(json!("TRUSTED")).is_err());
    assert!(serde_json::from_value::<EndpointDeploymentCapability>(json!("HTTP_PROXY")).is_err());
    assert!(serde_json::from_value::<SecureAccessConnectionLifecycle>(json!("READY")).is_err());
}

#[test]
fn managed_delivery_uses_kind_discriminator_for_all_transport_variants() {
    let cases = [
        json!({"kind": "HTTP_PROXY", "proxy_url": "http://127.0.0.1:8080"}),
        json!({"kind": "PROVIDER_TRANSPORT", "transport_provider_id": "provider-1", "route_reference": "route-1"}),
        json!({"kind": "SECURE_ACCESS", "peer_lease": peer_wire(), "route_projection": route_wire()}),
    ];
    for wire in cases {
        let delivery: EndpointManagedDelivery = serde_json::from_value(wire.clone()).unwrap();
        if let EndpointManagedDelivery::SecureAccess {
            peer_lease,
            route_projection,
        } = &delivery
        {
            peer_lease.validate().unwrap();
            route_projection.validate().unwrap();
        }
        roundtrip(&delivery, wire);
    }
    for invalid in [
        json!({"proxy_url": "http://localhost"}),
        json!({"kind": "UNKNOWN"}),
        json!({"kind": "HTTP_PROXY", "route_reference": "wrong-fields"}),
    ] {
        assert!(serde_json::from_value::<EndpointManagedDelivery>(invalid).is_err());
    }
}

#[test]
fn runtime_desired_state_preserves_tagged_endpoint_and_gateway_payloads() {
    let endpoint_wire = json!({"runtime_kind": "ENDPOINT", "desired_state": {
        "revision": "revision-1", "policy_version": "policy-1",
        "routing": {"default_route": "DIRECT", "rules": []}
    }});
    let endpoint: RuntimeDesiredState = serde_json::from_value(endpoint_wire.clone()).unwrap();
    assert_eq!(endpoint.runtime_kind(), RuntimeKind::Endpoint);
    if let RuntimeDesiredState::Endpoint(state) = &endpoint {
        state.validate().unwrap();
    }
    roundtrip(&endpoint, endpoint_wire);
    let gateway_wire = json!({"runtime_kind": "GATEWAY", "desired_state": {
        "schema_version": 1, "routes": [{"resource_id": "資源", "capabilities": ["MCP"]}]
    }});
    let gateway: RuntimeDesiredState = serde_json::from_value(gateway_wire.clone()).unwrap();
    assert_eq!(gateway.runtime_kind(), RuntimeKind::Gateway);
    roundtrip(&gateway, gateway_wire);
    assert!(serde_json::from_value::<RuntimeDesiredState>(
        json!({"runtime_kind": "ENDPOINT", "desired_state": {}})
    )
    .is_err());
    assert!(serde_json::from_value::<RuntimeDesiredState>(
        json!({"runtime_kind": "OTHER", "desired_state": {}})
    )
    .is_err());
}

#[test]
fn routing_rule_defaults_and_omits_client_compliance_but_preserves_present_requirement() {
    let wire = json!({"policy_rule_id": "rule-1", "resource_id": "resource-1", "host_suffix": "example.com", "route": "BLOCK", "managed_route": null, "policy_message": "Blocked"});
    let mut rule: EndpointRoutingRule = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(rule.client_compliance, None);
    roundtrip(&rule, wire.clone());
    let mut explicit_null = wire.clone();
    explicit_null["client_compliance"] = Value::Null;
    assert_eq!(
        serde_json::from_value::<EndpointRoutingRule>(explicit_null).unwrap(),
        rule
    );
    rule.client_compliance = Some(EndpointClientComplianceRequirement {
        acting_client_id: "client-1".into(),
        managed_configuration_revision: "config-1".into(),
        otel_collector_origin: "http://127.0.0.1:4318".into(),
    });
    let mut with_compliance = wire;
    with_compliance["client_compliance"] = json!({"acting_client_id": "client-1", "managed_configuration_revision": "config-1", "otel_collector_origin": "http://127.0.0.1:4318"});
    roundtrip(&rule, with_compliance);
}

#[test]
fn secure_access_desired_state_defaults_relay_and_preserves_present_allocation() {
    let wire = json!({"interface_name": "wg0", "listen_port": 51820, "peers": [peer_wire()], "routes": [route_wire()]});
    let mut state: SecureAccessDesiredState = serde_json::from_value(wire.clone()).unwrap();
    state.validate().unwrap();
    assert_eq!(state.relay, None);
    roundtrip(&state, wire.clone());
    state.relay = Some(SecureAccessRelayAllocation {
        allocation_id: "allocation-1".into(),
        turn_uri: "turn:192.0.2.2:3478".into(),
    });
    state.validate().unwrap();
    let mut with_relay = wire;
    with_relay["relay"] =
        json!({"allocation_id": "allocation-1", "turn_uri": "turn:192.0.2.2:3478"});
    roundtrip(&state, with_relay);
}

#[test]
fn legacy_runtime_report_defaults_collections_and_omits_absent_policy_version() {
    let wire = json!({"command_id": "command-1", "runtime_id": "endpoint-1", "runtime_kind": "ENDPOINT", "runtime_version": "1.0", "applied_state_revision": "revision-1", "health": "READY"});
    let mut report: RuntimeControlReport = serde_json::from_value(wire.clone()).unwrap();
    report
        .validate_for(RuntimeKind::Endpoint, &RuntimeId::from("endpoint-1"))
        .unwrap();
    assert!(report.components.is_empty());
    assert!(report.secure_access.is_empty());
    assert_eq!(report.applied_policy_version, None);
    let mut normalized = wire;
    normalized["components"] = json!([]);
    normalized["secure_access"] = json!([]);
    roundtrip(&report, normalized.clone());
    report.applied_policy_version = Some("policy-1".into());
    normalized["applied_policy_version"] = json!("policy-1");
    roundtrip(&report, normalized);
}

#[test]
fn timestamps_and_generations_are_unsigned_wire_numbers() {
    roundtrip(&Timestamp::new(1_700_000_000), json!(1_700_000_000));
    roundtrip(&SecureAccessGeneration::new(7), json!(7));
    for invalid in [json!(-1), json!(1.5), json!("1700000000"), Value::Null] {
        assert!(serde_json::from_value::<Timestamp>(invalid.clone()).is_err());
        assert!(serde_json::from_value::<SecureAccessGeneration>(invalid).is_err());
    }
}

#[test]
fn identifiers_remain_strings_in_identity_and_route_wire_contracts() {
    let identity = SubjectEvidence {
        subject_id: "subject:使用者-1".into(),
        evidence_level: EvidenceLevel::Verified,
    };
    roundtrip(
        &identity,
        json!({"subject_id": "subject:使用者-1", "evidence_level": "VERIFIED"}),
    );
    roundtrip(
        &ManagedRouteBinding {
            target: ManagedRouteTarget::AiMcp,
            provider_id: "provider-1".into(),
        },
        json!({"target": "AI_MCP", "provider_id": "provider-1"}),
    );
    assert!(serde_json::from_value::<SubjectEvidence>(
        json!({"subject_id": 1, "evidence_level": "VERIFIED"})
    )
    .is_err());
    assert!(serde_json::from_value::<ManagedRouteBinding>(
        json!({"target": "AI_MCP", "provider_id": {"value": "provider-1"}})
    )
    .is_err());
}
