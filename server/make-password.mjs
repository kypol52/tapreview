// Хеш пароля для входа в админку: node server/make-password.mjs
// Спрашивает пароль и печатает строку для ADMIN_PASSWORD_HASH (сам пароль нигде не сохраняется).

import { createInterface } from "node:readline/promises";
import { hashPassword } from "../src/admin-auth.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("Пароль для админ-панели (не меньше 10 символов): ");
rl.close();
if (password.length < 10) {
  console.error("Слишком короткий пароль");
  process.exit(1);
}
console.log(`\nADMIN_PASSWORD_HASH=${await hashPassword(password)}`);
