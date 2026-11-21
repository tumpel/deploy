# Test hosts

A test host is a KVM host reachable over SSH: a Linux machine or VM where `/dev/kvm` exists, such as a libvirt domain with `<cpu mode='host-passthrough'>` on a hypervisor with nested KVM. Each stage has a dedicated test host that runs the supervisor all the time. Set `TUMPEL_PROOF_HOST` to its SSH destination, a `Host` entry in `~/.ssh/config` or `user@address`; `npm run proof:e2e` refuses to start without it.

`TUMPEL_PROOF_HOST_NETWORK_TARGETS` lists, space-separated, the `host:port` addresses on the test host's own network that a box must not reach, such as the host's address with port 22 and its network's resolver with port 53. The isolation step of the proof probes them together with fixed private and link-local addresses, and refuses to start without them.

Test hosts are amd64, and releases build amd64 only: the flag `BUILD_ARM64` in `.github/workflows/release.yml` and `.github/workflows/images.yml` stays `false`. Nothing claims arm64 host support until a real arm64 host passes the proof.

A test host built from the Ubuntu 24.04 server cloud image needs a cloud-init seed with passwordless sudo, the group `kvm` for the login user, the key of the machine that runs the proof, no password login, and `qemu-guest-agent`. Give it at least 4 vCPU and 8 GiB. On a fresh host, drop the old host key with `ssh-keygen -R <address>`, then wait for the seed with `cloud-init status --wait` on the host. Then download the supervisor from the release and install it with the token on stdin, as Host setup below shows. The host reads Online in about 10 s.

A second host of the same build covers multi-host placement and cross-host concurrency.

## Installer proof matrix

Desktops and servers are both host targets. A desktop runs NetworkManager without systemd-networkd; a server cloud image runs systemd-networkd. The installer proves itself on one fresh host of each:

| Host    | Image                                                                     | Network stack    | TAP pool made by                      |
| ------- | ------------------------------------------------------------------------- | ---------------- | ------------------------------------- |
| server  | Ubuntu 24.04 server cloud image                                           | systemd-networkd | `/etc/systemd/network/50-tumpel<k>.*` |
| desktop | Ubuntu 24.04 desktop (`ubuntu-desktop-minimal` on the server cloud image) | NetworkManager   | `tumpel-tap-pool.service`             |

Build the desktop host like the server host, with these lines added to the seed's `user-data`:

```yaml
packages: [ubuntu-desktop-minimal, network-manager, nftables]
runcmd:
  - systemctl disable --now systemd-networkd.service systemd-networkd.socket
  - 'printf "network:\n  version: 2\n  renderer: NetworkManager\n" > /etc/netplan/01-network-manager.yaml'
  - rm -f /etc/netplan/50-cloud-init.yaml
  - netplan apply
```

Keep the `printf` line in single quotes: unquoted, its `: ` makes cloud-init reject the file with "Nested mappings are not allowed".

After `cloud-init status --wait`, reboot it once, then check that `systemctl is-active systemd-networkd` is `inactive` and `nmcli general status` answers. NetworkManager asks for a new DHCP lease, which can hand out another address. Read the address again, point the SSH destination at it and drop its old host key with `ssh-keygen -R <address>`. Then install as Host setup below shows.

## Release builds

GitHub Actions runs the image build of `.github/workflows/images.yml` on `ubuntu-latest`. The workflow installs its own tools. It publishes to the R2 bucket `tumpel-releases-<stage>` (`doc/release.md`).

## Host setup

`tumpel-supervisor install --endpoint <url> --token-file <path|->` turns the host into an enrolled, running Tumpel host in one run. Run it as the login user, never as root. It asks for admin rights only for its one-time setup. A second run on a set-up host repeats the setup steps and leaves their results as they are. A run that stopped part way finishes when run again. The running supervisor never escalates.

```sh
ssh "$TUMPEL_PROOF_HOST" 'curl -fL -o tumpel-supervisor <url>/v1/releases/supervisor/Amd64 && chmod +x tumpel-supervisor'
tumpel host mint-token --expires-in 600 | ssh "$TUMPEL_PROOF_HOST" ./tumpel-supervisor install --endpoint <url> --token-file -
```

The installer:

1. checks that the user can open `/dev/kvm`; when not, it adds the user to group `kvm`, restarts the user manager so the supervisor runs with that group, and checks the access once with `sg kvm`. When the seed already puts the user in `kvm`, this step does nothing;
2. writes `~/.local/state/tumpel-supervisor/runtime.json` (`SupervisorRuntime`) with defaults when the file is missing, and brings an older one to the current schema: it adds missing fields with their defaults and drops fields the schema no longer has;
3. downloads Firecracker v1.18.0 to `firecrackerPath`, checked against the digest the supervisor pins;
4. writes the guest filter `/etc/tumpel-guest-filter.nft` and the unit `tumpel-guest-filter.service` that loads it at boot;
5. makes the TAP pool: `boxCapacity` devices, 8 by default. Device `tumpel<k>` is owned by the user and has gateway 172.16.<k>.1/30, for guest 172.16.<k>.2. The guest filter table masquerades their traffic out of the host. With systemd-networkd running, networkd makes the devices. Without it, as on a NetworkManager desktop, the unit `tumpel-tap-pool.service` makes them with `ip tuntap` at boot and turns on IPv4 forwarding. The installer never turns networkd on. When NetworkManager is installed, `/etc/NetworkManager/conf.d/90-tumpel-unmanaged.conf` tells it to leave `tumpel*` devices alone. Each failing step names itself: nft load, NetworkManager reload, networkd reload or the TAP unit;
6. turns on lingering for the user, copies itself to `~/.local/bin/tumpel-supervisor` and enables the user unit `tumpel-supervisor.service`, which runs `tumpel-supervisor run` after the rollback check of EDD-008;
7. enrols the host with the token from the file or stdin and starts the unit.

To change the pool size, edit `boxCapacity` in `runtime.json` and run `tumpel-supervisor install` again; without `--endpoint` and `--token-file` it only sets up the host and restarts an enrolled supervisor. To enrol again, delete `~/.local/state/tumpel-supervisor` and repeat the install command above with `--endpoint` and `--token-file`. The host key is bound to the host id, not to the control plane hostname, so to move an enrolled host to a new endpoint, set `endpoint` in `~/.local/state/tumpel-supervisor/supervisor.json` and run `systemctl --user restart tumpel-supervisor`.

Check: `ip -br addr show` lists `tumpel0` to `tumpel7`, each `/sys/class/net/tumpel<k>/owner` is the user's uid, `systemctl is-active tumpel-guest-filter` is `active`, and `sysctl net.ipv4.ip_forward` is 1. All four hold after a reboot, on both hosts of the proof matrix.

## Guest isolation

A guest reaches the internet but never the internal network. The nftables table `inet tumpel_guest` drops anything forwarded from a `tumpel*` device to 10/8, 100.64/10, 169.254/16, 172.16/12 or 192.168/16. Those ranges cover the LAN, a libvirt network, the hypervisor, other VMs and every other box. The table also drops forwarded packets whose source lies outside 172.16.0.0/16. On the host itself, it drops every packet a box sends, so no host service, not even ping at the gateway, is reachable from a box. IPv6 forwarding is off, so a guest has no IPv6 path. The table also masquerades traffic from 172.16.0.0/16 that leaves through a non-`tumpel*` device. It is separate from networkd's `io.systemd.nat`, so neither flushes the other.

`tumpel-guest-filter.service` loads the table before `network-pre.target`, so the filter is in place before networkd or `tumpel-tap-pool.service` brings up the pool. `nftables.service` stays disabled, because its `/etc/nftables.conf` flushes the whole ruleset.

The guest image writes `/etc/resolv.conf` with the public resolvers 1.1.1.1 and 9.9.9.9. A guest can use neither the host's DNS, served only on 127.0.0.53, nor the resolver of the host's network, which the filter blocks.

To test with real traffic, swap `tumpel3` for a veth with its peer in a namespace, ping from the guest side, then put the TAP back. networkd configures the veth the same way as the TAP. Run the test while no box holds `tumpel3`. Set `RESOLVER` to the resolver of the host's network and `NEIGHBOUR` to another machine on it.

```sh
sudo ip link del tumpel3
sudo ip netns add tg
sudo ip link add tumpel3 type veth peer name eth0 netns tg
sudo ip -n tg addr add 172.16.3.2/30 dev eth0
sudo ip -n tg link set eth0 up
sudo networkctl reconfigure tumpel3
sudo ip -n tg route add default via 172.16.3.1
sudo nft reset counters table inet tumpel_guest
for a in 172.16.3.1 172.16.0.1 "$RESOLVER" "$NEIGHBOUR" 1.1.1.1; do
  sudo ip netns exec tg ping -c 1 -W 2 "$a" >/dev/null 2>&1 && echo "$a reached" || echo "$a blocked"
done
sudo nft list table inet tumpel_guest | grep counter
sudo ip netns del tg
sudo networkctl reload
ip -d link show tumpel3
```

Expected: 1.1.1.1 reached, the other four blocked. The drop of forwarded private-range traffic counts 1 packet and the input drop counts 3. Deleting the namespace removes the veth, and the last command shows `tun type tap ... user <name>` again.
