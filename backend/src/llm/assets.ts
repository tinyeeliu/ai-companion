/**
 * Pinned openai-api-server-via-codex release. Hashes are the GitHub release
 * checksums. A download that does not match is deleted.
 */
import type { ArchiveAsset } from '../tts/assets';

const VERSION = '0.2.2';
const BASE = `https://github.com/hotchpotch/openai-api-server-via-codex/releases/download/v${VERSION}`;

const BUILDS: Record<string, ArchiveAsset> = {
  'darwin-arm64': {
    url: `${BASE}/openai-api-server-via-codex_${VERSION}_darwin_arm64.tar.gz`,
    sha256: 'd1ca99cadf00b80bd9d3d3dc05e1f9c804a733ccc6fc6f3a83e888c4cdfdea8a',
    bytes: 2_834_731,
    filename: `openai-api-server-via-codex_${VERSION}_darwin_arm64.tar.gz`,
  },
  'darwin-x64': {
    url: `${BASE}/openai-api-server-via-codex_${VERSION}_darwin_amd64.tar.gz`,
    sha256: '176d8ff3c200c4f4acac3b6c710421de7248b368b67ba73dac91e93f1b614f35',
    bytes: 3_033_759,
    filename: `openai-api-server-via-codex_${VERSION}_darwin_amd64.tar.gz`,
  },
  'win32-x64': {
    url: `${BASE}/openai-api-server-via-codex_${VERSION}_windows_amd64.zip`,
    sha256: '6614e6ac59d61a99db578fc2f20168264417151a26148b44efd29e2fb0ca9543',
    bytes: 3_056_834,
    filename: `openai-api-server-via-codex_${VERSION}_windows_amd64.zip`,
  },
};

export function gatewayAsset(platform: string = process.platform, arch: string = process.arch): ArchiveAsset | null {
  return BUILDS[`${platform}-${arch}`] ?? null;
}

export function gatewayBinaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'openai-api-server-via-codex.exe' : 'openai-api-server-via-codex';
}
