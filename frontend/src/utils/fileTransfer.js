export const CHUNK_SIZE = 65536; // 64KB chunk size

/**
 * Computes the SHA-256 hash of a File or Blob.
 */
export const calculateSHA256 = async (fileOrBlob) => {
  const arrayBuffer = await fileOrBlob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Sends a file in chunks over a WebRTC DataChannel, respecting flow control.
 */
export const sendFileOverDataChannel = (dataChannel, file, onProgress, expectedHash) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let offset = 0;
    const size = file.size;

    dataChannel.bufferedAmountLowThreshold = 256 * 1024; // 256KB

    // Send metadata including cryptographic hash
    const meta = {
      type: 'meta',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      hash: expectedHash,
    };
    dataChannel.send(JSON.stringify(meta));

    const readSlice = (o) => {
      const slice = file.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
      const buffer = e.target.result;

      const sendChunk = () => {
        if (dataChannel.readyState !== 'open') {
          reject(new Error('DataChannel closed during transfer'));
          return;
        }

        try {
          dataChannel.send(buffer);
          offset += buffer.byteLength;
          onProgress(offset, size);

          if (offset < size) {
            if (dataChannel.bufferedAmount > 1024 * 1024) { // 1MB buffer limit
              dataChannel.onbufferedamountlow = () => {
                dataChannel.onbufferedamountlow = null;
                readSlice(offset);
              };
            } else {
              setTimeout(() => readSlice(offset), 0);
            }
          } else {
            resolve();
          }
        } catch (err) {
          reject(err);
        }
      };

      sendChunk();
    };

    reader.onerror = (err) => {
      reject(err);
    };

    readSlice(0);
  });
};

/**
 * Sends a file in chunks as raw binary WebSocket frames.
 */
export const sendFileOverWebSocket = (sendBinary, sendMessage, file, onProgress, expectedHash, isBroadcast = false) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let offset = 0;
    const size = file.size;

    // Send metadata depending on unicast relay or broadcast
    const type = isBroadcast ? 'broadcast-start' : 'relay-meta';
    sendMessage(type, {
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      hash: expectedHash,
    });

    const readSlice = (o) => {
      const slice = file.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
      const buffer = e.target.result;
      try {
        sendBinary(buffer);
        offset += buffer.byteLength;
        onProgress(offset, size);

        if (offset < size) {
          setTimeout(() => readSlice(offset), 1);
        } else {
          resolve();
        }
      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = (err) => {
      reject(err);
    };

    readSlice(0);
  });
};

/**
 * Formats size in bytes into human-readable format.
 */
export const formatSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * Formats speed in bytes/sec into human-readable format.
 */
export const formatSpeed = (bytesPerSec) => {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(1)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
};
