// Uso: npm run hash-pwd minhaSenha123
import bcrypt from "bcryptjs";

const senha = process.argv[2];
if (!senha) {
  console.error("Uso: npm run hash-pwd <sua-senha>");
  process.exit(1);
}

const hash = bcrypt.hashSync(senha, 10);
console.log("\nCole no .env (variável LOGIN_PASSWORD_HASH):\n");
console.log(hash);
console.log("");
