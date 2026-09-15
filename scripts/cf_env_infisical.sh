#!/usr/bin/env bash
# Source this (don't execute) to export CLOUDFLARE_API_TOKEN from Infisical.
#
#   . scripts/cf_env_infisical.sh
#
# Reads the machine-identity credentials from ${OD_INFISICAL_ENV_FILE:-$HOME/.env}
# (INFISICAL_CLIENT_ID, INFISICAL_SECRET, INFISICAL_PROJECT_ID, INFISICAL_ENVIRONMENT),
# logs in with universal auth, and fetches ONE named secret
# (${OD_CF_TOKEN_SECRET_NAME:-CLOUDFLARE_API_KEY}) into the environment as
# CLOUDFLARE_API_TOKEN, and ${OD_CF_ACCOUNT_SECRET_NAME:-CF_ACCOUNT_ID} as CLOUDFLARE_ACCOUNT_ID.
# Nothing is printed and nothing is written to disk. The token is only ever
# held in this shell's environment for the duration of the run.
#
# CLOUDFLARE_ACCOUNT_ID comes from wrangler.toml unless already set.
set +x
_od_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_od_envfile="${OD_INFISICAL_ENV_FILE:-$HOME/.env}"
if [[ -f "$_od_envfile" ]]; then
  set -a; # shellcheck disable=SC1090
  source "$_od_envfile"; set +a
fi
: "${INFISICAL_CLIENT_ID:?INFISICAL_CLIENT_ID missing (expected in $_od_envfile)}"
: "${INFISICAL_SECRET:?INFISICAL_SECRET missing}"
: "${INFISICAL_PROJECT_ID:?INFISICAL_PROJECT_ID missing}"
: "${INFISICAL_ENVIRONMENT:?INFISICAL_ENVIRONMENT missing}"

_od_secret_name="${OD_CF_TOKEN_SECRET_NAME:-CLOUDFLARE_API_KEY}"
_od_acct_name="${OD_CF_ACCOUNT_SECRET_NAME:-CF_ACCOUNT_ID}"
_od_tok="$(infisical login --method=universal-auth --client-id="$INFISICAL_CLIENT_ID" \
            --client-secret="$INFISICAL_SECRET" --plain --silent)" || { echo "infisical login failed" >&2; return 1 2>/dev/null || exit 1; }

_od_get() {  # $1 = env slug, $2 = secret name
  INFISICAL_TOKEN="$_od_tok" infisical secrets get "$2" \
    --projectId "$INFISICAL_PROJECT_ID" --env "$1" --plain --silent 2>/dev/null
}
# Infisical env *slugs* are usually lowercase; accept the display name as given first.
_od_env="$INFISICAL_ENVIRONMENT"
_od_val="$(_od_get "$_od_env" "$_od_secret_name")"
if [[ -z "$_od_val" ]]; then
  # display name -> slug (Infisical's defaults): Development->dev, Staging->staging, Production->prod
  case "$(printf '%s' "$INFISICAL_ENVIRONMENT" | tr '[:upper:]' '[:lower:]')" in
    development|dev) _od_env="dev" ;;
    production|prod) _od_env="prod" ;;
    staging)         _od_env="staging" ;;
    *)               _od_env="$(printf '%s' "$INFISICAL_ENVIRONMENT" | tr '[:upper:]' '[:lower:]')" ;;
  esac
  _od_val="$(_od_get "$_od_env" "$_od_secret_name")"
fi
if [[ -z "$_od_val" ]]; then
  echo "could not fetch secret '$_od_secret_name' from Infisical env '$INFISICAL_ENVIRONMENT'" >&2
  unset _od_tok; return 1 2>/dev/null || exit 1
fi
export CLOUDFLARE_API_TOKEN="$_od_val"
_od_acct="$(_od_get "$_od_env" "$_od_acct_name")"
[[ -n "$_od_acct" ]] && export CLOUDFLARE_ACCOUNT_ID="$_od_acct"
if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  export CLOUDFLARE_ACCOUNT_ID="$(grep -E '^account_id = ' "$_od_root/wrangler.toml" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
fi
unset _od_tok _od_val _od_acct _od_env _od_get _od_secret_name _od_acct_name _od_envfile
echo "cloudflare token loaded from infisical (len ${#CLOUDFLARE_API_TOKEN}); account ${CLOUDFLARE_ACCOUNT_ID}" >&2
