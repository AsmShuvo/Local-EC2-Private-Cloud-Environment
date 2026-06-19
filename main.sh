#!/bin/bash
set -e

echo "=== Cloud Host Hardware Audit ==="
free -h
echo "CPU virtualization flags:"
egrep -c '(vmx|svm)' /proc/cpuinfo

if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo to apply system fixes."
    exit 0
fi

echo "=== Applying DevStack System Prerequisites ==="

SWAP_GB=$(( $(awk '/^SwapTotal:/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
if [ "$SWAP_GB" -lt 8 ]; then
    fallocate -l 8G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "8GB swap file is active and persisted."
else
    echo "Swap memory is safe (>= 8GB)"
fi

if systemctl is-active --quiet docker; then
    systemctl stop docker docker.socket containerd
    systemctl disable docker docker.socket containerd
    echo "Docker services stopped to prevent iptables network conflicts"
fi

if ! id stack >/dev/null 2>&1; then
    useradd -s /bin/bash -d /opt/stack -m stack
    echo "stack ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/stack
    chmod 440 /etc/sudoers.d/stack
    echo "stack user created."
fi

echo "=== Phase 1 provisioning complete ==="
