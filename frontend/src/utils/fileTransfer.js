export const CHUNK_SIZE = 65536; // 64KB chunk size

/**
 * FileStorage: Transient IndexedDB storage to prevent memory exhaustion
 * during large file transfers. Chunks are buffered on disk and cleared immediately on finish.
 */
export class FileStorage {
  constructor() {
    this.db = null;
  }

  init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('landrop_transient_db', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('chunks')) {
          db.createObjectStore('chunks');
        }
      };
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve();
      };
      request.onerror = (e) => reject(new Error('IndexedDB initialization failed: ' + e.target.error));
    });
  }

  clear() {
    return new Promise((resolve) => {
      if (!this.db) return resolve();
      try {
        const transaction = this.db.transaction(['chunks'], 'readwrite');
        const store = transaction.objectStore('chunks');
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
      } catch (err) {
        resolve();
      }
    });
  }

  putChunk(index, chunk) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('Database not initialized'));
      try {
        const transaction = this.db.transaction(['chunks'], 'readwrite');
        const store = transaction.objectStore('chunks');
        const request = store.put(chunk, index);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  getAllChunks() {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('Database not initialized'));
      try {
        const transaction = this.db.transaction(['chunks'], 'readonly');
        const store = transaction.objectStore('chunks');
        const chunks = [];
        const request = store.openCursor();
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            chunks.push(cursor.value);
            cursor.continue();
          } else {
            resolve(chunks);
          }
        };
        request.onerror = (e) => reject(e.target.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Computes the SHA-256 hash of a File or Blob.
 * NOTE: The native Web Crypto digest API requires loading the entire buffer into RAM at once.
 * This triggers a transient finalization memory spike proportional to the file size,
 * although RAM usage is flat during the network transfer phase.
 */
export const calculateSHA256 = async (fileOrBlob) => {
  if (!crypto || !crypto.subtle) {
    console.warn('Web Crypto API is not available (unsecure context). Skipping hash calculation.');
    return '';
  }
  const arrayBuffer = await fileOrBlob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Cryptographic helpers for ECDH key exchange and AES-256-GCM encryption
 */

export const generateECDHKeyPair = async () => {
  return await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
};

export const exportPublicKey = async (publicKey) => {
  const exported = await crypto.subtle.exportKey('spki', publicKey);
  return btoa(String.fromCharCode(...new Uint8Array(exported)));
};

export const importPublicKey = async (spkiBase64) => {
  const binaryDerString = atob(spkiBase64);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }
  return await crypto.subtle.importKey(
    'spki',
    binaryDer.buffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
};

export const deriveSharedSecretKey = async (privateKey, otherPublicKey) => {
  return await crypto.subtle.deriveKey(
    { name: 'ECDH', public: otherPublicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
};

/**
 * Computes an optional 4-digit numeric fingerprint to authenticate the ECDH session key
 * out-of-band to prevent active Man-in-the-Middle (MitM) attacks.
 */
export const calculateFingerprint = async (pubKeyA, pubKeyB) => {
  if (!pubKeyA || !pubKeyB) return '';
  const keys = [pubKeyA, pubKeyB].sort();
  const encoder = new TextEncoder();
  const data = encoder.encode(keys.join(''));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  const code = ((hashArray[0] << 8) + hashArray[1]) % 10000;
  return code.toString().padStart(4, '0');
};

export const encryptChunk = async (sharedKey, chunkBuffer) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    chunkBuffer
  );
  const packet = new Uint8Array(12 + ciphertext.byteLength);
  packet.set(iv, 0);
  packet.set(new Uint8Array(ciphertext), 12);
  return packet.buffer;
};

export const decryptChunk = async (sharedKey, packetBuffer) => {
  const packet = new Uint8Array(packetBuffer);
  if (packet.byteLength < 12) {
    throw new Error('Malformed encrypted packet');
  }
  const iv = packet.slice(0, 12);
  const ciphertext = packet.slice(12);
  return await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    ciphertext.buffer
  );
};

export const encryptMetadata = async (sharedKey, metadata) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(metadata));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    data.buffer
  );
  const packet = new Uint8Array(12 + ciphertext.byteLength);
  packet.set(iv, 0);
  packet.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...packet));
};

export const decryptMetadata = async (sharedKey, metadataBase64) => {
  const binaryString = atob(metadataBase64);
  const packet = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    packet[i] = binaryString.charCodeAt(i);
  }
  if (packet.byteLength < 12) {
    throw new Error('Malformed encrypted metadata');
  }
  const iv = packet.slice(0, 12);
  const ciphertext = packet.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    ciphertext.buffer
  );
  const decoder = new TextDecoder();
  return JSON.parse(decoder.decode(decrypted));
};

/**
 * Sends a file in chunks over a WebRTC DataChannel, respecting flow control and encryption.
 */
export const sendFileOverDataChannel = (dataChannel, file, onProgress, expectedHash, sharedKey) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let offset = 0;
    const size = file.size;

    dataChannel.bufferedAmountLowThreshold = 256 * 1024; // 256KB

    const startTransfer = async () => {
      try {
        const rawMeta = {
          name: file.name,
          size: file.size,
          mime: file.type || 'application/octet-stream',
          hash: expectedHash,
        };

        if (sharedKey) {
          const encryptedMeta = await encryptMetadata(sharedKey, rawMeta);
          dataChannel.send(JSON.stringify({ type: 'meta-encrypted', payload: encryptedMeta }));
        } else {
          dataChannel.send(JSON.stringify({ type: 'meta', ...rawMeta }));
        }

        const readSlice = (o) => {
          const slice = file.slice(o, o + CHUNK_SIZE);
          reader.readAsArrayBuffer(slice);
        };

        reader.onload = async (e) => {
          let buffer = e.target.result;

          try {
            if (sharedKey) {
              buffer = await encryptChunk(sharedKey, buffer);
            }

            const sendChunk = () => {
              if (dataChannel.readyState !== 'open') {
                reject(new Error('DataChannel closed during transfer'));
                return;
              }

              try {
                dataChannel.send(buffer);
                offset += e.target.result.byteLength; // original size for progress
                onProgress(offset, size);

                if (offset < size) {
                  if (dataChannel.bufferedAmount > 1024 * 1024) { // 1MB buffer limit
                    let resolved = false;
                    const resume = () => {
                      if (resolved) return;
                      resolved = true;
                      dataChannel.onbufferedamountlow = null;
                      readSlice(offset);
                    };
                    dataChannel.onbufferedamountlow = resume;
                    // Fallback polling timer in case the event is missed or not supported
                    const checkBuffer = () => {
                      if (resolved || dataChannel.readyState !== 'open') return;
                      if (dataChannel.bufferedAmount <= 256 * 1024) {
                        resume();
                      } else {
                        setTimeout(checkBuffer, 30);
                      }
                    };
                    setTimeout(checkBuffer, 60);
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
          } catch (err) {
            reject(err);
          }
        };

        reader.onerror = (err) => reject(err);
        readSlice(0);
      } catch (err) {
        reject(err);
      }
    };

    startTransfer();
  });
};

/**
 * Sends a file in chunks as raw binary WebSocket frames (relayed or broadcast).
 */
export const sendFileOverWebSocket = (sendBinary, sendMessage, file, onProgress, expectedHash, isBroadcast, sharedKey) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let offset = 0;
    const size = file.size;

    const startTransfer = async () => {
      try {
        const rawMeta = {
          name: file.name,
          size: file.size,
          mime: file.type || 'application/octet-stream',
          hash: expectedHash,
        };

        const type = isBroadcast ? 'broadcast-start' : 'relay-meta';

        if (sharedKey && !isBroadcast) {
          const encryptedMeta = await encryptMetadata(sharedKey, rawMeta);
          sendMessage(type, { encrypted: encryptedMeta });
        } else {
          sendMessage(type, rawMeta);
        }

        const readSlice = (o) => {
          const slice = file.slice(o, o + CHUNK_SIZE);
          reader.readAsArrayBuffer(slice);
        };

        reader.onload = async (e) => {
          let buffer = e.target.result;

          try {
            if (sharedKey && !isBroadcast) {
              buffer = await encryptChunk(sharedKey, buffer);
            }

            sendBinary(buffer);
            offset += e.target.result.byteLength;
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

        reader.onerror = (err) => reject(err);
        readSlice(0);
      } catch (err) {
        reject(err);
      }
    };

    startTransfer();
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
