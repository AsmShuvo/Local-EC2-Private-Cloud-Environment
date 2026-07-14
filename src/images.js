// OS image catalog — our equivalent of an AWS AMI list.
//
// KEY FACT: `multipass launch` accepts either a catalog alias OR a cloud-image
// URL:   multipass launch [[<remote:>]<image> | <url>]
//
// That means we are NOT limited to Multipass's built-in Ubuntu catalog — any
// cloud image (qcow2) can be booted by URL. Verified end-to-end: launching the
// Debian 12 genericcloud image produced a real "Debian GNU/Linux 12 (bookworm)"
// VM. Multipass still provisions its own `ubuntu` default user inside, so
// cloud-init key injection and `multipass exec … bash -l` behave identically
// across images.
const IMAGES = [
  {
    id: "ubuntu",
    name: "Ubuntu Server",
    // No launch argument at all => Multipass boots its default Ubuntu LTS.
    launchArg: null,
    minDisk: 5, // GB — Ubuntu's cloud image needs headroom
    username: "ubuntu",
    description: "Default LTS · Multipass native image",
  },
  {
    id: "debian-12",
    name: "Debian 12 (Bookworm)",
    launchArg:
      "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2",
    minDisk: 2, // GB — Debian's genericcloud image is far leaner than Ubuntu's
    username: "ubuntu",
    description: "Lightweight · booted from the official Debian cloud image",
  },
];

const DEFAULT_IMAGE = "ubuntu";

/** Public catalog for the launch wizard (launchArg stays server-side). */
function listImages() {
  return IMAGES.map(({ launchArg, ...pub }) => pub);
}

function getImage(id) {
  return IMAGES.find((i) => i.id === id) || null;
}

/**
 * Resolve a requested OS. Unknown ids are rejected rather than silently
 * downgraded — we never boot a different OS than the user asked for.
 * @returns {{ image }} | {{ error }}
 */
function resolveImage(requested) {
  const id = String(requested || DEFAULT_IMAGE).trim() || DEFAULT_IMAGE;
  const image = getImage(id);
  if (!image) return { error: `Unknown operating system: ${id}` };
  return { image };
}

module.exports = { IMAGES, DEFAULT_IMAGE, listImages, getImage, resolveImage };
