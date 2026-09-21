{{- $processorAdapters := default (dict) .Values.processorAdapters -}}
{{- $configMap := default (dict) $processorAdapters.configMap -}}
{{- $credentials := default (dict) $processorAdapters.credentials -}}
{{- $configMapName := default "" $configMap.name -}}
{{- $configMapKey := default "" $configMap.key -}}
{{- $bindings := default (list) $credentials.env -}}
{{- if not (kindIs "slice" $bindings) -}}
{{- fail "processorAdapters.credentials.env must be a list" -}}
{{- end -}}
{{- if and $configMapName (not $configMapKey) -}}
{{- fail "processorAdapters.configMap.key is required when processorAdapters.configMap.name is set" -}}
{{- end -}}
{{- if and (not $configMapName) (gt (len $bindings) 0) -}}
{{- fail "processorAdapters.credentials.env requires processorAdapters.configMap.name" -}}
{{- end -}}
{{- $credentialNames := dict -}}
{{- range $index, $binding := $bindings -}}
{{- $name := required (printf "processorAdapters.credentials.env[%d].name is required" $index) $binding.name -}}
{{- if hasKey $credentialNames $name -}}
{{- fail (printf "processorAdapters.credentials.env contains duplicate name %s" $name) -}}
{{- end -}}
{{- $_ := set $credentialNames $name true -}}
{{- $secretKeyRef := default (dict) $binding.secretKeyRef -}}
{{- $secretName := default $credentials.secretName $secretKeyRef.name -}}
{{- $secretKey := required (printf "processorAdapters.credentials.env[%d].secretKeyRef.key is required" $index) $secretKeyRef.key -}}
{{- if not $secretName -}}
{{- fail (printf "processorAdapters.credentials.env[%d] requires credentials.secretName or secretKeyRef.name" $index) -}}
{{- end -}}
{{- if not (regexMatch "^[A-Z][A-Z0-9_]*_(API_KEY|TOKEN)$" $name) -}}
{{- fail (printf "processorAdapters.credentials.env[%d].name must end in _API_KEY or _TOKEN" $index) -}}
{{- end -}}
{{- if or (hasPrefix "GENIO_ONE_" $name) (hasPrefix "OTEL_" $name) (hasPrefix "NODE_" $name) (hasPrefix "BUN_" $name) (hasPrefix "KUBERNETES_" $name) -}}
{{- fail (printf "processorAdapters.credentials.env[%d].name uses a reserved process environment prefix" $index) -}}
{{- end -}}
{{- end -}}
