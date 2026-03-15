{{- define "bot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "bot.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "bot.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "bot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "bot.labels" -}}
helm.sh/chart: {{ include "bot.chart" . }}
app.kubernetes.io/name: {{ include "bot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "bot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "bot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "bot.authSecretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-auth" (include "bot.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "bot.servicesSecretName" -}}
{{- if .Values.config.servicesExistingSecret -}}
{{- .Values.config.servicesExistingSecret -}}
{{- else -}}
{{- printf "%s-services" (include "bot.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "bot.authPersistenceClaimName" -}}
{{- if .Values.auth.persistence.existingClaim -}}
{{- .Values.auth.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-auth" (include "bot.fullname" .) -}}
{{- end -}}
{{- end -}}
