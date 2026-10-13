/**
 * Turn a WAV file into the raw PCM OpenAI's `response_format: "pcm"` is:
 * signed 16-bit little-endian, mono. Kokoro's file is 24 kHz. A 16-bit PCM
 * wav is returned as its data chunk; a float wav is converted.
 */
export function wavToPcm(wav: Uint8Array): Uint8Array {
  if (wav.byteLength < 12 || textAt(wav, 0, 4) !== 'RIFF' || textAt(wav, 8, 4) !== 'WAVE') {
    throw new Error('speech engine did not write a wav file');
  }
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let offset = 12;
  let format = 0;
  let channels = 0;
  let bits = 0;
  let data: Uint8Array | null = null;
  while (offset + 8 <= wav.byteLength) {
    const id = textAt(wav, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > wav.byteLength) break;
    if (id === 'fmt ' && size >= 16) {
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      bits = view.getUint16(start + 14, true);
    } else if (id === 'data') {
      data = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (data == null) throw new Error('speech engine wrote a wav file with no audio');
  if (channels !== 1) throw new Error('speech engine wrote a multi-channel wav');
  if (format === 1 && bits === 16) return new Uint8Array(data);
  if (format === 3 && bits === 32) return floatToPcm16(data);
  throw new Error(`speech engine wrote wav format ${format} at ${bits} bits`);
}

function floatToPcm16(data: Uint8Array): Uint8Array {
  const floats = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const samples = Math.floor(data.byteLength / 4);
  const out = new Uint8Array(samples * 2);
  const pcm = new DataView(out.buffer);
  for (let i = 0; i < samples; i += 1) {
    const sample = Math.max(-1, Math.min(1, floats.getFloat32(i * 4, true)));
    pcm.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return out;
}

function textAt(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[offset + i] ?? 0);
  return text;
}
