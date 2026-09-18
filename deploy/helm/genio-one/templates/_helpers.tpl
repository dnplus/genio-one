{{- define "genio-one.name" -}}
genio-one
{{- end -}}

{{- define "genio-one.fullname" -}}
{{- printf "%s-genio-one" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "genio-one.labels" -}}
app.kubernetes.io/name: {{ include "genio-one.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: genio-one
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "genio-one.runtime-owns" -}}
{{- $resource := index . 0 -}}
{{- $manager := index . 1 -}}
{{- $owned := false -}}
{{- if and $resource (hasKey $resource "metadata") -}}
{{- range $field := (default (list) $resource.metadata.managedFields) -}}
{{- if eq $field.manager $manager -}}
{{- $owned = true -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if $owned }}true{{ end -}}
{{- end -}}

{{- define "genio-one.secretName" -}}
{{- default (printf "%s-secrets" (include "genio-one.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "genio-one.image" -}}
{{- $image := index . 0 -}}
{{- if $image.digest -}}
{{ printf "%s@%s" $image.repository $image.digest }}
{{- else -}}
{{ printf "%s:%s" $image.repository (required "a product image tag or digest is required" $image.tag) }}
{{- end -}}
{{- end -}}

{{- define "genio-one.storageClass" -}}
{{- if .Values.global.storageClass }}
storageClassName: {{ .Values.global.storageClass | quote }}
{{- end }}
{{- end -}}

{{- define "genio-one.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
