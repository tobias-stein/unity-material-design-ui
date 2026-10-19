#!/usr/bin/env bash
# Fixture export / verification for the UI telemetry viewer (P0 acceptance).
#
#   ./scripts/export-fixtures.sh           regenerate committed fixtures
#                                          (needs the compose InfluxDB running)
#   ./scripts/export-fixtures.sh --check   verify fixtures are reproducible
#                                          (read-only; CI-friendly)
#   ./scripts/export-fixtures.sh --no-live edge fixtures only (no InfluxDB)
#
# The heavy lifting (query, canonicalization, validation) lives in
# scripts/export-fixtures.mjs; this wrapper only forwards arguments.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/export-fixtures.mjs" "$@"
