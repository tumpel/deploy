# Test hosts

`tumpel-host` is a libvirt domain on the hypervisor `box` with nested KVM, for running the MicroVM runtime. Reach it from `sandbox` with `ssh tumpel-host` (192.168.122.188, user `mvhenten`, network `default`).

- 4 vCPU, 8 GiB, q35, `<cpu mode='host-passthrough'>`, so `/dev/kvm` exists in the guest.
- Disk `/mnt/nvme/vms/tumpel-host.qcow2`, 40 G, standalone qcow2 converted from `~/vm-staging/noble-server-cloudimg-amd64-20261017.img` (Ubuntu 24.04, sha256 `04e8f246...5b6c94`, checked against Ubuntu's SHA256SUMS).
- Cloud-init NoCloud seed `tumpel-host-seed.iso` in the same directory, built from `~/vm-staging/tumpel-host-seed/{meta-data,user-data}`: passwordless sudo, the group `kvm`, sandbox's key, no password login, `qemu-guest-agent`, 2 G swapfile.
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

`virsh undefine --remove-all-storage` cannot delete the disk and the seed under `/mnt/nvme/vms`, because libvirt does not manage them. Remove them by hand. Each host gets its IP from a DHCP lease on the network `default`. A rebuild of `tumpel-host-2` with the same MAC got 192.168.122.217 back.

On a fresh host, drop the old host key on `sandbox` with `ssh-keygen -R <address>`, then wait for the seed with `cloud-init status --wait` on the host. Then download the supervisor from the release and install it with the token on stdin, as Host setup below shows. The host reads Online in about 10 s.

## Second host

`tumpel-host-2` is a sibling of `tumpel-host` for multi-host placement and cross-host concurrency. `ssh tumpel-host-2` from `sandbox` reaches it (192.168.122.217, user `mvhenten`, network `default`).

It was made with the rebuild steps above, with every `tumpel-host` name replaced by `tumpel-host-2`: same CPU passthrough, 4 vCPU, 8 GiB, a 40 G disk `tumpel-host-2.qcow2` beside the first one, from the same cloud image, and the seed `~/vm-staging/tumpel-host-2-seed/` with only the hostname and instance id changed. Its domain XML, `tumpel-host-2.xml` in that seed directory and a copy in `~/vm-config/` on box, sets its own UUID and MAC `52:54:00:ac:16:42`. Autostart is off.

It runs the same `tumpel-supervisor install` as the first host and fetches its guest images from the release.

## Release builds

GitHub Actions runs `.github/workflows/release.yml` on the runner that the repository variable `BUILD_RUNNER` names, now the self-hosted label `tumpel-build`. With the variable unset, it uses `ubuntu-24.04`. The workflow installs its own tools. It publishes to the R2 bucket `tumpel-releases-<stage>` (`doc/deploy.md`).

The self-hosted runner is a second runner instance on the VM `github-actions-runner` on `box`. It lives in `/home/runner/actions-runner-tumpel` as a service, registered to `mvhenten/tumpel` as `github-actions-runner-tumpel`. Leave the other project's runners there alone. The VM does not autostart. When it spins a vCPU, run `virsh destroy`, then `virsh start`. Never reboot it.

`runner@` accepts only devbox's key. From `sandbox`: `ssh -J box,homelab devbox`, then `ssh -J box runner@192.168.122.50`.

On 2026-11-15 `box` has 16 threads and 58.7 GiB. `sandbox` takes 8 vCPU and 16 GiB, each test host 4 and 8, `github-actions-runner` 12 and 24, and `lab` 4 and 16 (off by default). A third 8 GiB host does not fit while the runner runs.

## Host setup

`tumpel-supervisor install --endpoint <url> --token-file <path|->` turns the host into an enrolled, running Tumpel host in one run. Run it as `mvhenten`, never as root. It asks for admin rights only for its one-time setup. A second run on a set-up host repeats the setup steps and leaves their results as they are. The running supervisor never escalates.

```sh
ssh tumpel-host 'curl -fL -o tumpel-supervisor <url>/v1/releases/supervisor/Amd64 && chmod +x tumpel-supervisor'
tumpel host mint-token --expires-in 600 | ssh tumpel-host ./tumpel-supervisor install --endpoint <url> --token-file -
```

The installer:

1. checks that `mvhenten` can open `/dev/kvm`; when not, it adds the user to group `kvm`, restarts the user manager so the supervisor runs with that group, and checks the access once with `sg kvm`. On these test hosts the seed already puts `mvhenten` in `kvm`, so this step does nothing;
2. writes `~/.local/state/tumpel-supervisor/runtime.json` (`SupervisorRuntime`) with defaults when the file is missing, and brings an older one to the current schema: it adds missing fields with their defaults and drops fields the schema no longer has;
3. downloads Firecracker v1.18.0 to `firecrackerPath`, checked against the digest pinned in `crates/tumpel-supervisor/src/install.rs`;
4. writes the guest filter `/etc/tumpel-guest-filter.nft` and the unit `tumpel-guest-filter.service` that loads it at boot;
5. makes the TAP pool through systemd-networkd: `boxCapacity` devices, 8 by default. Device `tumpel<k>` is owned by `mvhenten` and has gateway 172.16.<k>.1/30 with IPv4 masquerade out of `enp1s0`, for guest 172.16.<k>.2;
6. turns on lingering for `mvhenten`, copies itself to `~/.local/bin/tumpel-supervisor` and enables the user unit `tumpel-supervisor.service`, which runs `tumpel-supervisor run`;
7. enrols the host with the token from the file or stdin and starts the unit.

To change the pool size, edit `boxCapacity` in `runtime.json` and run `tumpel-supervisor install` again; without `--endpoint` and `--token-file` it only sets up the host and restarts an enrolled supervisor. To enrol again, delete `~/.local/state/tumpel-supervisor` and repeat the install command above with `--endpoint` and `--token-file`. The host key is bound to the host id, not to the control plane hostname, so to move an enrolled host to a new endpoint, set `endpoint` in `~/.local/state/tumpel-supervisor/supervisor.json` and run `systemctl --user restart tumpel-supervisor`.

Check: `ip -br addr show` lists `tumpel0` to `tumpel7`, each `/sys/class/net/tumpel<k>/owner` is 1000, `systemctl is-active tumpel-guest-filter` is `active`, and `sysctl net.ipv4.ip_forward` is 1. All four hold after a reboot.

## Guest isolation

A guest reaches the internet but never the internal network. The nftables table `inet tumpel_guest` drops anything forwarded from a `tumpel*` device to 10/8, 100.64/10, 169.254/16, 172.16/12 or 192.168/16. Those ranges cover the LAN, the libvirt network, the hypervisor `box`, other VMs and every other box. The table also drops forwarded packets whose source lies outside 172.16.0.0/16. On the host itself, it drops every packet a box sends, so no host service, not even ping at the gateway, is reachable from a box. IPv6 forwarding is off, so a guest has no IPv6 path. The table is separate from networkd's `io.systemd.nat`, so neither flushes the other.

`tumpel-guest-filter.service` loads the table before `network-pre.target`, so the filter is in place before networkd brings up the pool. `nftables.service` stays disabled, because its `/etc/nftables.conf` flushes the whole ruleset.

The guest image writes `/etc/resolv.conf` with the public resolvers 1.1.1.1 and 9.9.9.9. A guest can use neither the host's DNS, served only on 127.0.0.53, nor the libvirt resolver 192.168.122.1, which the filter blocks.

To test with real traffic, swap `tumpel3` for a veth with its peer in a namespace, ping from the guest side, then put the TAP back. networkd configures the veth the same way as the TAP. Run the test while no box holds `tumpel3`.

```sh
sudo ip link del tumpel3
sudo ip netns add tg
sudo ip link add tumpel3 type veth peer name eth0 netns tg
sudo ip -n tg addr add 172.16.3.2/30 dev eth0
sudo ip -n tg link set eth0 up
sudo networkctl reconfigure tumpel3
sudo ip -n tg route add default via 172.16.3.1
sudo nft reset counters table inet tumpel_guest
for a in 172.16.3.1 172.16.0.1 192.168.122.1 192.168.122.188 1.1.1.1; do
  sudo ip netns exec tg ping -c 1 -W 2 "$a" >/dev/null 2>&1 && echo "$a reached" || echo "$a blocked"
done
sudo nft list table inet tumpel_guest | grep counter
sudo ip netns del tg
sudo networkctl reload
ip -d link show tumpel3
```

Expected: 1.1.1.1 reached, the other four blocked. The drop of forwarded private-range traffic counts 1 packet and the input drop counts 3. Deleting the namespace removes the veth, and the last command shows `tun type tap ... user mvhenten` again.
