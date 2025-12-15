import { Prisma, PrismaClient } from "../DB/prisma-client/index.js";
const prisma = new PrismaClient({
  log: ["info", "warn", "error"],
  transactionOptions: { timeout: 100000, maxWait: 150000 },
});
await prisma.$connect();
console.log("Connected to the local SQLLite database successfully.");
export { prisma, Prisma };
