/**
 * Pinned Kokoro weights and the sherpa-onnx build that runs them.
 * Hashes are the GitHub release digests. A download that does not match is
 * deleted, so a partial file can never be treated as installed.
 */
export interface ArchiveAsset {
  url: string;
  sha256: string;
  bytes: number;
  filename: string;
}

export const MODEL_ASSET: ArchiveAsset = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2',
  sha256: 'c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298',
  bytes: 349_906_910,
  filename: 'kokoro-multi-lang-v1_0.tar.bz2',
};

const ENGINES: Record<string, ArchiveAsset> = {
  'darwin-arm64': {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-osx-arm64-shared.tar.bz2',
    sha256: 'b10e5c7e2c30ea03de9c442655d14860d9edc475c6251d58a8f5f06e913a1d56',
    bytes: 20_314_448,
    filename: 'sherpa-onnx-v1.13.8-osx-arm64-shared.tar.bz2',
  },
  'win32-x64': {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MD-Release.tar.bz2',
    sha256: '3e971a04b2e0ba4dfa53d381a006367ce8c9f5f09b4ae00043e9845c2baded22',
    bytes: 20_494_724,
    filename: 'sherpa-onnx-v1.13.8-win-x64-shared-MD-Release.tar.bz2',
  },
};

export function engineAsset(platform = process.platform, arch = process.arch): ArchiveAsset | null {
  return ENGINES[`${platform}-${arch}`] ?? null;
}
