#!/usr/bin/env bash
# Phase 0: base system setup for a local DevStack host.
# Run with: sudo ./phase0-system-setup.sh

set -euo pipefail

STACK_USER="stack"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this as root: sudo $0" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get upgrade -y
apt-get install -y --no-install-recommends git curl net-tools sudo

# Create the stack user only if it isn't already there.
if ! id -u "${STACK_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${STACK_USER}"
fi

# Passwordless sudo via a dedicated drop-in, validated before install.
SUDOERS_FILE="/etc/sudoers.d/${STACK_USER}"
TMP_SUDOERS="$(mktemp)"
echo "${STACK_USER} ALL=(ALL) NOPASSWD:ALL" > "${TMP_SUDOERS}"

if visudo -c -f "${TMP_SUDOERS}" >/dev/null 2>&1; then
  install -m 0440 -o root -g root "${TMP_SUDOERS}" "${SUDOERS_FILE}"
else
  echo "sudoers rule failed validation, aborting" >&2
  rm -f "${TMP_SUDOERS}"
  exit 1
fi
rm -f "${TMP_SUDOERS}"

echo "Done. Switch to the stack user with: sudo su - ${STACK_USER}"
