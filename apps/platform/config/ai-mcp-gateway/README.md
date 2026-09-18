# AI Gateway development configuration

`provider-versions.env` pins the Envoy Gateway and Envoy AI Gateway versions
used by the local installer and smoke checks. `local/` contains standalone
`aigw run` fixtures for development only.

Kubernetes configuration is owned by `deploy/helm/genio-one`. Gateway runtime
resources are compiled from published product state. This directory does not
contain a second static runtime bundle, processor policy, RBAC manifest, or
controller values authority.
