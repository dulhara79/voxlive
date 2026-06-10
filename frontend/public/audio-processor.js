/**
 * PCMProcessor — AudioWorklet for VoxLive
 *
 * Converts Float32 samples from the microphone to Int16 LINEAR16 PCM
 * and posts them to the main thread via zero-copy ArrayBuffer transfer.
 *
 * Buffer size: 4096 samples = 256 ms at 16 kHz.
 * This gives a good balance between latency and WebSocket overhead.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf   = new Int16Array(4096);
    this._index = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      // Clamp Float32 [-1, 1] → Int16 [-32768, 32767]
      const clamped      = Math.max(-1, Math.min(1, channel[i]));
      this._buf[this._index++] = clamped < 0 ? clamped * 32768 : clamped * 32767;

      if (this._index >= this._buf.length) {
        // Transfer ownership (zero-copy) to the main thread
        const copy = new Int16Array(this._buf);
        this.port.postMessage(copy.buffer, [copy.buffer]);
        // Allocate a fresh buffer for the next batch
        this._buf   = new Int16Array(4096);
        this._index = 0;
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);
