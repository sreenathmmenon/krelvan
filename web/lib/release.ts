// This value is checked against the root package, lockfiles, Docker image and embedded
// protocol version by `npm run release:check`. Customer-facing commands must import it.
export const RELEASE_VERSION = "0.1.1";
export const RELEASE_TAG = `v${RELEASE_VERSION}`;
export const NPM_COMMAND = `npx krelvan@${RELEASE_VERSION}`;
export const DOCKER_IMAGE = `ghcr.io/sreenathmmenon/krelvan:${RELEASE_VERSION}`;
export const RELEASE_ASSET = `krelvan-${RELEASE_VERSION}.tgz`;
export const RELEASE_BASE_URL =
  `https://github.com/sreenathmmenon/krelvan/releases/download/${RELEASE_TAG}`;
