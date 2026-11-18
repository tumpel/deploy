#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh: must run as root on the runner VM" >&2
  exit 1
fi

here=$(dirname "$0")

apt-get -o DPkg::Lock::Timeout=600 update
apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends squashfs-tools

install -m 0755 "$here/runner-prune.sh" /usr/local/bin/runner-prune
install -m 0644 "$here/runner-prune.service" /etc/systemd/system/runner-prune.service
install -m 0644 "$here/runner-prune.timer" /etc/systemd/system/runner-prune.timer
install -d /etc/systemd/journald.conf.d
install -m 0644 "$here/journald-size.conf" /etc/systemd/journald.conf.d/size.conf

systemctl daemon-reload
systemctl restart systemd-journald
systemctl enable --now runner-prune.timer
