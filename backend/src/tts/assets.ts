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

/** uv for Apple Silicon. It creates the speech venv; Python itself is not bundled. */
export const UV_ASSET: ArchiveAsset = {
  url: 'https://github.com/astral-sh/uv/releases/download/0.13.0/uv-aarch64-apple-darwin.tar.gz',
  sha256: 'a9c1b29002cf3c83f07fa9cd8a887a3be0107d90e23189721221e7257db8e3d6',
  bytes: 14_692_549,
  filename: 'uv-aarch64-apple-darwin.tar.gz',
};

/** Pinned speech packages. English G2P needs the en extra, the spaCy model, and zh. */
export const MLX_AUDIO_SPEC = 'mlx-audio==0.5.8';
export const MISAKI_SPEC = 'misaki[en,zh]==0.9.4';
export const SPACY_MODEL_SPEC =
  'https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl';
