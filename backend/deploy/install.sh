#!/usr/bin/env bash
# Run on the chosen Ubuntu server from the backend directory, after copying
# only the allowlisted source files. Credentials must be provisioned separately.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $(id -u) != 0 ]]; then
  echo 'Run with sudo bash deploy/install.sh' >&2
  exit 1
fi
command -v podman >/dev/null || {
  apt-get update
  apt-get install -y --no-install-recommends podman
}
install -d -m 0700 /etc/kisj-menu
install -d -o 10001 -g 10001 -m 0750 /var/lib/kisj-menu
podman build --tag localhost/kisj-menu:current .
install -m 0644 deploy/kisj-menu.service /etc/systemd/system/kisj-menu.service
install -m 0644 deploy/kisj-menu.timer /etc/systemd/system/kisj-menu.timer
systemctl daemon-reload
if [[ ! -f /etc/kisj-menu/firebase.json ]]; then
  echo 'Image and units installed. Provision /etc/kisj-menu/firebase.json (uid 10001, mode 0400), then enable the timer.'
  exit 0
fi
chown 10001:10001 /etc/kisj-menu/firebase.json
chmod 0400 /etc/kisj-menu/firebase.json
systemctl start kisj-menu.service
systemctl enable --now kisj-menu.timer
systemctl list-timers kisj-menu.timer --no-pager
