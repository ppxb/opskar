import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import { isPathInside } from "../backend/path-containment";
import type { SecretCipher } from "../backend/provider-credential-store";
import { ServerStartupFailed } from "./server-options";

const HEADER = Buffer.from("OPSKAR_CREDENTIAL_V1\0", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_KEY_FILE_BYTES = 256;

function authenticatedContext(context: string | undefined): Buffer {
  return Buffer.concat([HEADER, Buffer.from(JSON.stringify(context ?? null), "utf8")]);
}

/** Authenticated Node ciphertext. Desktop safeStorage ciphertext is not accepted. */
export class ServerSecretCipher implements SecretCipher {
  readonly #key: Buffer;
  #disposed = false;

  constructor(key: Buffer) {
    this.#key = key;
    registerSecretValue(key.toString("base64"));
    registerSecretValue(key.toString("hex"));
  }

  encrypt(value: string, context?: string): Buffer {
    if (this.#disposed) throw new Error("The server cipher is closed.");
    registerSecretValue(value, { allowShort: true });
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(authenticatedContext(context));
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([HEADER, nonce, encrypted, cipher.getAuthTag()]);
  }

  decrypt(value: Buffer, context?: string): string {
    try {
      if (this.#disposed) throw new Error("The server cipher is closed.");
      if (value.length < HEADER.length + NONCE_BYTES + TAG_BYTES || !value.subarray(0, HEADER.length).equals(HEADER)) {
        throw new Error("Unknown server ciphertext format.");
      }
      const nonceEnd = HEADER.length + NONCE_BYTES;
      const tagStart = value.length - TAG_BYTES;
      const decipher = createDecipheriv("aes-256-gcm", this.#key, value.subarray(HEADER.length, nonceEnd), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(authenticatedContext(context));
      decipher.setAuthTag(value.subarray(tagStart));
      const plain = Buffer.concat([decipher.update(value.subarray(nonceEnd, tagStart)), decipher.final()]);
      const secret = plain.toString("utf8");
      plain.fill(0);
      registerSecretValue(secret, { allowShort: true });
      return secret;
    } catch {
      throw new Error("The server credential could not be decrypted.");
    }
  }

  dispose(): void {
    this.#key.fill(0);
    this.#disposed = true;
  }
}

/** Read an operator-supplied key. No production key is generated or replaced by the server. */
export const acquireServerCipher = Effect.fn("acquireServerCipher")(function* (keyFile: string, dataDirectory: string) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async (signal) => {
        const directory = await realpath(dataDirectory);
        const path = await realpath(keyFile);
        if (isPathInside(directory, path)) {
          throw new Error("Keep the credential key outside the server data directory.");
        }
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size > MAX_KEY_FILE_BYTES) throw new Error("Invalid credential key file.");
        if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
          throw new Error("The credential key file must be private to its operating-system user.");
        }
        const text = (await readFile(path, { encoding: "utf8", signal })).trim();
        if (!/^[A-Za-z0-9+/]{43}=$/u.test(text))
          throw new Error("The credential key must contain 32 base64-encoded bytes.");
        const key = Buffer.from(text, "base64");
        if (key.length !== KEY_BYTES || key.toString("base64") !== text) {
          key.fill(0);
          throw new Error("The credential key is not canonical base64.");
        }
        return new ServerSecretCipher(key);
      },
      catch: (cause) => new ServerStartupFailed({ code: "credential-key", cause }),
    }),
    (cipher) => Effect.sync(() => cipher.dispose()),
  );
});
