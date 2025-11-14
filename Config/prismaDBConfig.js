import { Prisma, PrismaClient } from "../DB/prisma-client/index.js";
import {
  Prisma as PrismaQueue,
  PrismaClient as PrismaClientQueue,
} from "../DB/prisma-client-queue/index.js";
const prisma = new PrismaClient({
  log: ["info", "warn", "error"],
  transactionOptions: { timeout: 100000, maxWait: 150000 },
});
const prisma_queue = new PrismaClientQueue({
  log: ["info", "warn", "error"],
});
await prisma_queue.$connect();
await prisma.$connect();
console.log("Connected to the local SQLLite database successfully.");
export { prisma, Prisma, PrismaQueue, prisma_queue };
