#!/bin/sh
# Runs the real gh with a one-repository token that aos on the Mac provides on demand.
if [ -n "${AOS_GITHUB_SPOOL:-}" ] && [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  if token=$(node /usr/local/lib/aos/aos-github.mjs token); then
    GH_TOKEN=$token
    export GH_TOKEN
  fi
fi

if [ -n "${AOS_GITHUB_STATUS:-}" ]; then
  /usr/bin/gh "$@"
  code=$?
  [ "$code" -eq 0 ] || echo "aos: $AOS_GITHUB_STATUS" >&2
  exit "$code"
fi
exec /usr/bin/gh "$@"
