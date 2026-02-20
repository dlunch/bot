{{- define "slack-openai-bot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "slack-openai-bot.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "slack-openai-bot.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "slack-openai-bot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "slack-openai-bot.labels" -}}
helm.sh/chart: {{ include "slack-openai-bot.chart" . }}
app.kubernetes.io/name: {{ include "slack-openai-bot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "slack-openai-bot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "slack-openai-bot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "slack-openai-bot.authSecretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-auth" (include "slack-openai-bot.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "slack-openai-bot.servicesSecretName" -}}
{{- if .Values.config.servicesExistingSecret -}}
{{- .Values.config.servicesExistingSecret -}}
{{- else -}}
{{- printf "%s-services" (include "slack-openai-bot.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "slack-openai-bot.botConfigMapName" -}}
{{- if .Values.config.botConfigExistingConfigMap -}}
{{- .Values.config.botConfigExistingConfigMap -}}
{{- else -}}
{{- printf "%s-bot-config" (include "slack-openai-bot.fullname" .) -}}
{{- end -}}
{{- end -}}

