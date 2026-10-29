import { randomInt } from "node:crypto";
import { checkPasswordPolicy } from "../auth/password.js";

// No 0/O, 1/l/I: the password is read out or typed from a message, so look-alikes would cause lock-outs.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/**
 * A random one-time password such as "kF7p-Qm3x-Vt8N-wR2c": 16 characters from a 57-character
 * alphabet (about 93 bits), from the operating system's secure random source. It is shown once,
 * hashed immediately, and replaced by the person at first sign-in.
 */
export function generateTemporaryPassword(email?: string, random: (max: number) => number = randomInt): string {
  for (;;) {
    const chars = Array.from({ length: 16 }, () => ALPHABET[random(ALPHABET.length)]!);
    const password = [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
    if (checkPasswordPolicy(password, { email }).length === 0) return password;
  }
}
