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
