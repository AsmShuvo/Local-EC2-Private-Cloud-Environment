// OS image catalog — our equivalent of an AWS AMI list.
//
// HARD CONSTRAINT: Multipass can only boot Ubuntu-family images (verified with
// `multipass find`). There is no Debian/Fedora/Alpine support and never will be
// — those require swapping in the libvirt/QEMU driver. The unsupported entries
// below are shown in the wizard as "Coming soon" and REJECTED by the API. We
// never silently substitute a different OS than the user asked for.
const IMAGES = [
  {
    id: "ubuntu-26.04",
    name: "Ubuntu Server 26.04 LTS",
    family: "ubuntu",
    multipassAlias: "26.04", // resolute
    supported: true,
    username: "ubuntu",
    description: "Latest LTS · 64-bit (x86) · default",
  },
  {
    id: "ubuntu-24.04",
    name: "Ubuntu Server 24.04 LTS",
    family: "ubuntu",
    multipassAlias: "24.04", // noble
    supported: true,
    username: "ubuntu",
    description: "LTS · 64-bit (x86)",
  },
  {
    id: "ubuntu-22.04",
    name: "Ubuntu Server 22.04 LTS",
    family: "ubuntu",
    multipassAlias: "22.04", // jammy
    supported: true,
    username: "ubuntu",
    description: "LTS · 64-bit (x86) · widest compatibility",
  },
  {
    id: "debian-12",
    name: "Debian 12 (Bookworm)",
    family: "debian",
    supported: false,
    username: "admin",
    description: "Needs the libvirt driver — coming soon",
  },
  {
    id: "fedora-40",
    name: "Fedora Server 40",
    family: "fedora",
    supported: false,
    username: "fedora",
    description: "Needs the libvirt driver — coming soon",
  },
];

const DEFAULT_IMAGE = "ubuntu-26.04";

function listImages() {
  return IMAGES.map(({ multipassAlias, ...pub }) => pub);
}

function getImage(id) {
  return IMAGES.find((i) => i.id === id) || null;
}

/**
 * Validate a requested image. Returns { image } or { error }.
 * Unsupported images are rejected outright rather than silently downgraded.
 */
function resolveImage(requested) {
  const id = (requested || DEFAULT_IMAGE).trim();
  const image = getImage(id);
  if (!image) return { error: `Unknown OS image: ${id}` };
  if (!image.supported) {
    return {
      error: `${image.name} is not available yet. Multipass can only boot Ubuntu images; other operating systems arrive with the libvirt driver.`,
    };
  }
  return { image };
}

module.exports = { IMAGES, DEFAULT_IMAGE, listImages, getImage, resolveImage };
