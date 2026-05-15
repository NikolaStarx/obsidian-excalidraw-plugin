export const IV_LENGTH_BYTES = 12;
const ENCRYPTION_KEY_BITS = 128;

export const bytesToHexString = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const generateRoomId = (): string => {
  const buffer = new Uint8Array(10);
  window.crypto.getRandomValues(buffer);
  return bytesToHexString(buffer);
};

export const createIV = (): Uint8Array<ArrayBuffer> => {
  const iv = new Uint8Array(IV_LENGTH_BYTES);
  window.crypto.getRandomValues(iv);
  return iv;
};

export const generateEncryptionKey = async (): Promise<string> => {
  const key = await window.crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: ENCRYPTION_KEY_BITS,
    },
    true,
    ["encrypt", "decrypt"],
  );
  const jwk = await window.crypto.subtle.exportKey("jwk", key);
  return jwk.k;
};

const getCryptoKey = (key: string, usage: KeyUsage): Promise<CryptoKey> =>
  window.crypto.subtle.importKey(
    "jwk",
    {
      alg: "A128GCM",
      ext: true,
      k: key,
      key_ops: ["encrypt", "decrypt"],
      kty: "oct",
    },
    {
      name: "AES-GCM",
      length: ENCRYPTION_KEY_BITS,
    },
    false,
    [usage],
  );

export const encryptData = async (
  key: string,
  data: Uint8Array<ArrayBuffer> | ArrayBuffer | string,
): Promise<{ encryptedBuffer: ArrayBuffer; iv: Uint8Array<ArrayBuffer> }> => {
  const importedKey = await getCryptoKey(key, "encrypt");
  const iv = createIV();
  const buffer = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const encryptedBuffer = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    importedKey,
    buffer,
  );

  return { encryptedBuffer, iv };
};

export const decryptData = async (
  iv: Uint8Array<ArrayBuffer>,
  encrypted: Uint8Array<ArrayBuffer> | ArrayBuffer,
  privateKey: string,
): Promise<ArrayBuffer> => {
  const key = await getCryptoKey(privateKey, "decrypt");
  return window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    encrypted,
  );
};
