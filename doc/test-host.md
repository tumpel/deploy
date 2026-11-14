# MicroVM test host

`tumpel-host` is a libvirt domain on the hypervisor `box` with nested KVM, for running the MicroVM runtime. Reach it from `sandbox` with `ssh tumpel-host` (192.168.122.188, user `mvhenten`, network `default`).

- 4 vCPU, 8 GiB, q35, `<cpu mode='host-passthrough'>`, so `/dev/kvm` exists in the guest and `mvhenten` (group `kvm`) can open it.
- Disk `/mnt/nvme/vms/tumpel-host.qcow2`, 40 G, standalone qcow2 converted from `~/vm-staging/noble-server-cloudimg-amd64-20261017.img` (Ubuntu 24.04, sha256 `04e8f246...5b6c94`, checked against Ubuntu's SHA256SUMS).
- Cloud-init NoCloud seed `/mnt/nvme/vms/tumpel-host-seed.iso`, built from `~/vm-staging/tumpel-host-seed/{meta-data,user-data}`: passwordless sudo, sandbox's key, no password login, `qemu-guest-agent`, 2 G swapfile.
- Domain XML: `~/vm-config/tumpel-host.xml` on box. Autostart is off.

Rebuild, on box as `mvhenten` (no sudo needed):

```sh
V="virsh -c qemu:///system"; $V destroy tumpel-host; $V undefine tumpel-host
cd ~/vm-staging/tumpel-host-seed
xorriso -as mkisofs -output /mnt/nvme/vms/tumpel-host-seed.iso -volid cidata -joliet -rock meta-data user-data
qemu-img convert -O qcow2 ~/vm-staging/noble-server-cloudimg-amd64-20261017.img /mnt/nvme/vms/tumpel-host.qcow2
qemu-img resize /mnt/nvme/vms/tumpel-host.qcow2 40G
$V define ~/vm-staging/tumpel-host-seed/tumpel-host.xml && $V start tumpel-host && $V domifaddr tumpel-host
```

## Guest network

systemd-networkd owns the TAP `tumpel0` (owned by `mvhenten`), gives it 172.16.0.1/30 and masquerades the guest's 172.16.0.2 out of `enp1s0` with open egress. `IPMasquerade=ipv4` also turns on IPv4 forwarding. Both survive a reboot. Set up once, as `mvhenten`:

```sh
printf '[NetDev]\nName=tumpel0\nKind=tap\n\n[Tap]\nUser=mvhenten\n' | sudo tee /etc/systemd/network/50-tumpel0.netdev
printf '[Match]\nName=tumpel0\n\n[Network]\nAddress=172.16.0.1/30\nIPMasquerade=ipv4\nConfigureWithoutCarrier=yes\n' | sudo tee /etc/systemd/network/50-tumpel0.network
sudo networkctl reload
```

Check: `sysctl net.ipv4.ip_forward` is 1, `sudo nft list table ip io.systemd.nat` masquerades 172.16.0.0/30, and `ip route get 1.1.1.1 from 172.16.0.2 iif tumpel0` goes via `enp1s0`.

## Guest isolation

The guest reaches the internet but never the internal network. The nftables table `inet tumpel_guest` drops anything forwarded from `tumpel0` to 10/8, 100.64/10, 169.254/16, 172.16/12 or 192.168/16, which covers the LAN, the libvirt network, the hypervisor `box` and other VMs. It also drops anything from `tumpel0` addressed to the host itself, except the gateway 172.16.0.1. IPv6 forwarding is off, so the guest has no IPv6 path. The table is separate from networkd's `io.systemd.nat`, so neither flushes the other.

A oneshot unit loads it before `network-pre.target`, so the filter is in place before networkd brings up `tumpel0`. `nftables.service` stays disabled, because its `/etc/nftables.conf` flushes the whole ruleset. Set up once, as `mvhenten`:

```sh
sudo tee /etc/tumpel-guest-filter.nft <<'EOF'
table inet tumpel_guest
delete table inet tumpel_guest
table inet tumpel_guest {
	set private4 {
		type ipv4_addr
		flags interval
		elements = { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 }
	}

	chain forward {
		type filter hook forward priority filter; policy accept;
		iifname "tumpel0" ip daddr @private4 counter drop
	}

	chain input {
		type filter hook input priority filter; policy accept;
		iifname "tumpel0" ip daddr 172.16.0.1 accept
		iifname "tumpel0" counter drop
	}
}
EOF
sudo tee /etc/systemd/system/tumpel-guest-filter.service <<'EOF'
[Unit]
Description=Keep tumpel guests off private networks
DefaultDependencies=no
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/tumpel-guest-filter.nft
ExecStop=/usr/sbin/nft delete table inet tumpel_guest

[Install]
WantedBy=sysinit.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now tumpel-guest-filter.service
```

The guest image has an empty `/etc/resolv.conf` and the host serves DNS only on 127.0.0.53, so the guest resolves no names through the gateway. A resolver added to the image must be a public one: the libvirt resolver 192.168.122.1 is blocked.

Check: `systemctl is-active tumpel-guest-filter` is `active` after a reboot and `sudo nft list table inet tumpel_guest` shows both chains. To test with real traffic, swap the TAP for a veth named `tumpel0` with its peer in a namespace (networkd configures it as it would the TAP), ping from the guest side, then put the TAP back. No box may be running.

```sh
sudo ip link del tumpel0
sudo ip netns add tg
sudo ip link add tumpel0 type veth peer name eth0 netns tg
sudo ip -n tg addr add 172.16.0.2/30 dev eth0
sudo ip -n tg link set eth0 up
sudo networkctl reconfigure tumpel0
sudo ip -n tg route add default via 172.16.0.1
sudo nft reset counters table inet tumpel_guest
for a in 172.16.0.1 192.168.122.1 192.168.122.188 10.0.0.1 1.1.1.1; do
  sudo ip netns exec tg ping -c 1 -W 2 "$a" >/dev/null 2>&1 && echo "$a reached" || echo "$a blocked"
done
sudo nft list table inet tumpel_guest | grep counter
sudo ip netns del tg
sudo ip link del tumpel0
sudo networkctl reload
ip -d link show tumpel0
```

Expected: 172.16.0.1 and 1.1.1.1 reached, the other three blocked, the forward drop counter at 2 packets and the input drop counter at 1. The last command shows `tun type tap ... user mvhenten` again.
