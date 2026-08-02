#!/usr/bin/env bash
# Prueft die Kette vom Container bis zum oeffentlichen Endpunkt, bevor der
# Connector in Claude angelegt wird. Liest PUBLIC_URL und OIDC_ISSUER aus .env.
#
#   ./selbsttest.sh                 # gegen PUBLIC_URL aus der .env
#   ./selbsttest.sh http://127.0.0.1:18000   # direkt gegen den Container

set -uo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BASE="${1:-${PUBLIC_URL:-}}"
BASE="${BASE%/}"
ISSUER="${OIDC_ISSUER:-}"
ISSUER="${ISSUER%/}"

if [[ -z "$BASE" ]]; then
  echo "PUBLIC_URL ist nicht gesetzt und es wurde keine URL uebergeben." >&2
  exit 2
fi

pass=0
fail=0

ok()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFEHLER\033[0m %s\n' "$1"; fail=$((fail + 1)); }
info() { printf '        %s\n' "$1"; }

echo
echo "Pruefe $BASE"
echo

# 1 -------------------------------------------------------------------------
echo "1. Healthcheck"
body=$(curl -sS --max-time 10 -w '\n__CODE__%{http_code}' "$BASE/healthz" 2>&1)
code="${body##*__CODE__}"
body="${body%%$'\n'__CODE__*}"
if [[ "$body" == *'"status"'*'"ok"'* ]]; then
  ok "/healthz antwortet (HTTP $code)"
else
  bad "/healthz antwortet nicht wie erwartet (HTTP ${code:-keine Antwort})"
  info "${body:0:300}"
  case "$code" in
    502|503) info "Der Proxy erreicht den Container nicht - Forward Hostname und Port pruefen." ;;
    404)     info "Der Proxy antwortet, leitet aber woanders hin." ;;
    000|"")  info "Keine Verbindung - DNS, TLS oder es existiert kein Proxy Host fuer diese Domain." ;;
  esac
fi

# 2 -------------------------------------------------------------------------
echo
echo "2. Protected Resource Metadata"
meta=$(curl -sS --max-time 10 "$BASE/.well-known/oauth-protected-resource" 2>&1)
if [[ "$meta" == *'"resource"'* ]]; then
  ok "Metadata wird ausgeliefert"
  info "$meta"
  if [[ -n "$ISSUER" && "$meta" != *"$ISSUER"* ]]; then
    bad "Issuer in der Metadata weicht von OIDC_ISSUER ab"
    info "erwartet: $ISSUER"
  fi
else
  bad "Metadata fehlt oder ist kein JSON"
  info "$meta"
fi

# 3 -------------------------------------------------------------------------
echo
echo "3. MCP-Endpunkt ohne Token"
headers=$(curl -sS -i -o /dev/null -D - -X POST --max-time 10 \
  -H 'Content-Type: application/json' "$BASE/mcp" 2>&1)
code=$(printf '%s' "$headers" | awk 'NR==1{print $2}')
if [[ "$code" == "401" ]]; then
  ok "401 wie erwartet"
else
  bad "Statuscode $code statt 401"
fi
if printf '%s' "$headers" | grep -qi 'www-authenticate.*resource_metadata'; then
  ok "WWW-Authenticate mit resource_metadata vorhanden"
else
  bad "WWW-Authenticate fehlt - ohne diesen Header findet Claude den Login nicht"
fi

# 4 -------------------------------------------------------------------------
echo
echo "4. Authentik erreichbar"
if [[ -z "$ISSUER" ]]; then
  info "OIDC_ISSUER nicht gesetzt, uebersprungen"
else
  disco=$(curl -sS --max-time 10 -w '\n__CODE__%{http_code}' \
    "$ISSUER/.well-known/openid-configuration" 2>&1)
  dcode="${disco##*__CODE__}"
  disco="${disco%%$'\n'__CODE__*}"
  if [[ "$disco" == *'"jwks_uri"'* ]]; then
    ok "OpenID-Discovery liefert jwks_uri (HTTP $dcode)"
  else
    bad "Discovery nicht erreichbar oder unvollstaendig (HTTP ${dcode:-keine Antwort})"
    # Authentik antwortet bei unbekanntem Slug mit einer HTML-Seite. Die
    # ungekuerzt auszugeben hilft niemandem - die Deutung schon.
    if [[ "$disco" == *"<!DOCTYPE"* || "$disco" == *"<html"* ]]; then
      info "Es kam HTML statt JSON zurueck."
      if [[ "$disco" == *"Not Found"* || "$dcode" == "404" ]]; then
        info "Authentik kennt diesen Slug nicht. Der Issuer enthaelt den Slug der"
        info "APPLICATION, nicht den Namen des Providers."
        info "In Authentik: Applications -> Applications -> Slug ablesen, oder beim"
        info "Provider die angezeigte OpenID Configuration URL uebernehmen."
      fi
    else
      info "${disco:0:300}"
    fi
  fi
fi

# ---------------------------------------------------------------------------
echo
if (( fail == 0 )); then
  printf '\033[32mAlles gruen\033[0m (%d Pruefungen). Der Connector kann angelegt werden.\n' "$pass"
else
  printf '\033[31m%d von %d Pruefungen fehlgeschlagen.\033[0m\n' "$fail" "$((pass + fail))"
fi
echo
exit $(( fail > 0 ))
